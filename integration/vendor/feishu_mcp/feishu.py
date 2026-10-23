from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlparse

import httpx

from .config import Settings
from .storage import TokenStore


DOCX_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
SHEET_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9_:-]+$")
URL_PATTERN = re.compile(r"https?://[^\s<>\]\[\)\(\"']+", re.IGNORECASE)


def parse_docx_token(document_id_or_url: str) -> str:
    value = document_id_or_url.strip()
    if "://" in value:
        parsed = urlparse(value)
        parts = [part for part in parsed.path.split("/") if part]
        try:
            docx_index = parts.index("docx")
            value = parts[docx_index + 1]
        except (ValueError, IndexError) as exc:
            raise ValueError("Expected a Feishu Docx URL containing /docx/<token>") from exc
    if not DOCX_TOKEN_PATTERN.fullmatch(value):
        raise ValueError("Invalid Feishu Docx document token")
    return value


def parse_sheet_token(spreadsheet_token_or_url: str) -> str:
    value = spreadsheet_token_or_url.strip()
    if "://" in value:
        parsed = urlparse(value)
        parts = [part for part in parsed.path.split("/") if part]
        try:
            sheets_index = parts.index("sheets")
            value = parts[sheets_index + 1]
        except (ValueError, IndexError) as exc:
            raise ValueError(
                "Expected a Feishu Sheets URL containing /sheets/<token>"
            ) from exc
    if not SHEET_TOKEN_PATTERN.fullmatch(value):
        raise ValueError("Invalid Feishu spreadsheet token")
    return value


def parse_bitable_token(app_token_or_url: str) -> str:
    value = app_token_or_url.strip()
    if "://" in value:
        parsed = urlparse(value)
        parts = [part for part in parsed.path.split("/") if part]
        try:
            base_index = parts.index("base")
            value = parts[base_index + 1]
        except (ValueError, IndexError) as exc:
            raise ValueError("Expected a Feishu Base URL containing /base/<token>") from exc
    if not IDENTIFIER_PATTERN.fullmatch(value):
        raise ValueError("Invalid Feishu Bitable app token")
    return value


def _validate_identifier(value: str, label: str) -> str:
    normalized = value.strip()
    if not normalized or not IDENTIFIER_PATTERN.fullmatch(normalized):
        raise ValueError(f"Invalid {label}")
    return normalized


def safe_download_name(value: str, fallback: str = "download.bin") -> str:
    name = value.strip().replace("\\", "_").replace("/", "_")
    name = re.sub(r"[<>:\"|?*\x00-\x1f]", "_", name).strip(" .")
    if not name:
        name = fallback
    return name[:180]


def _decode_message_content(raw_content: Any) -> Any:
    if not isinstance(raw_content, str):
        return raw_content
    try:
        return json.loads(raw_content)
    except json.JSONDecodeError:
        return {"raw": raw_content}


def _collect_content_references(value: Any) -> tuple[list[str], list[dict[str, str]]]:
    urls: list[str] = []
    resources: list[dict[str, str]] = []

    def walk(item: Any) -> None:
        if isinstance(item, dict):
            for key, child in item.items():
                if key in {"image_key", "file_key"} and isinstance(child, str):
                    resources.append({"type": "image" if key == "image_key" else "file", "key": child})
                if key in {"href", "url"} and isinstance(child, str) and child.startswith(("http://", "https://")):
                    urls.append(child)
                walk(child)
        elif isinstance(item, list):
            for child in item:
                walk(child)
        elif isinstance(item, str):
            urls.extend(URL_PATTERN.findall(item))

    walk(value)
    unique_urls = list(dict.fromkeys(urls))
    unique_resources = list({(item["type"], item["key"]): item for item in resources}.values())
    return unique_urls, unique_resources


def normalize_message(message: dict[str, Any]) -> dict[str, Any]:
    body = message.get("body") or {}
    content = _decode_message_content(body.get("content", ""))
    urls, resources = _collect_content_references(content)
    return {
        "message_id": message.get("message_id", ""),
        "root_id": message.get("root_id", ""),
        "parent_id": message.get("parent_id", ""),
        "thread_id": message.get("thread_id", ""),
        "chat_id": message.get("chat_id", ""),
        "msg_type": message.get("msg_type", ""),
        "create_time": message.get("create_time", ""),
        "update_time": message.get("update_time", ""),
        "deleted": bool(message.get("deleted", False)),
        "updated": bool(message.get("updated", False)),
        "sender": message.get("sender", {}),
        "mentions": message.get("mentions", []),
        "content": content,
        "urls": urls,
        "resources": resources,
    }


class FeishuAPIError(RuntimeError):
    pass


class FeishuClient:
    def __init__(self, settings: Settings, token_store: TokenStore) -> None:
        self.settings = settings
        self.token_store = token_store

    async def _post_oauth(self, payload: dict[str, Any]) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{self.settings.base_url}/open-apis/authen/v2/oauth/token",
                json=payload,
                headers={"Content-Type": "application/json; charset=utf-8"},
            )
        try:
            data = response.json()
        except ValueError:
            data = {}
        if response.is_error:
            code = data.get("code", response.status_code)
            message = data.get("error_description") or data.get("msg") or response.reason_phrase
            raise FeishuAPIError(f"{message} (code {code})")
        if data.get("code", 0) not in (0, None):
            raise FeishuAPIError(data.get("msg") or "Feishu OAuth request failed")
        return data.get("data", data)

    async def exchange_code(self, code: str) -> dict[str, Any]:
        token = await self._post_oauth(
            {
                "grant_type": "authorization_code",
                "client_id": self.settings.app_id,
                "client_secret": self.settings.app_secret,
                "code": code,
                "redirect_uri": self.settings.redirect_uri,
            }
        )
        token["obtained_at"] = int(time.time())
        self.token_store.save(token)
        return token

    async def _refresh(self, refresh_token: str) -> dict[str, Any]:
        token = await self._post_oauth(
            {
                "grant_type": "refresh_token",
                "client_id": self.settings.app_id,
                "client_secret": self.settings.app_secret,
                "refresh_token": refresh_token,
            }
        )
        token["obtained_at"] = int(time.time())
        self.token_store.save(token)
        return token

    async def access_token(self) -> str:
        token = self.token_store.load()
        if token is None:
            raise RuntimeError("No authorized Feishu user. Visit /oauth/start first.")
        expires_in = int(token.get("expires_in", 0))
        obtained_at = int(token.get("obtained_at", 0))
        if expires_in and time.time() >= obtained_at + expires_in - 60:
            refresh_token = token.get("refresh_token")
            if not refresh_token:
                raise RuntimeError("Feishu access token expired and no refresh token is stored")
            token = await self._refresh(refresh_token)
        access_token = token.get("access_token")
        if not access_token:
            raise RuntimeError("Stored Feishu OAuth response has no access_token")
        return str(access_token)

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        access_token = await self.access_token()
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.request(
                method,
                f"{self.settings.base_url}{path}",
                params=params,
                json=json,
                headers={"Authorization": f"Bearer {access_token}"},
            )
        try:
            payload = response.json()
        except ValueError:
            payload = {}
        if response.is_error or payload.get("code") not in (0, None):
            code = payload.get("code", response.status_code)
            message = payload.get("msg") or response.reason_phrase or "Feishu API request failed"
            raise FeishuAPIError(f"{message} (code {code})")
        return payload.get("data", {})

    async def _request_binary(
        self,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        max_bytes: int | None = None,
    ) -> tuple[bytes, str, str]:
        access_token = await self.access_token()
        limit = max_bytes or self.settings.max_download_bytes
        chunks: list[bytes] = []
        total = 0
        async with httpx.AsyncClient(timeout=120) as client:
            async with client.stream(
                "GET",
                f"{self.settings.base_url}{path}",
                params=params,
                headers={"Authorization": f"Bearer {access_token}"},
            ) as response:
                content_type = response.headers.get("content-type", "application/octet-stream")
                if response.is_error or "application/json" in content_type:
                    payload = json.loads((await response.aread()).decode("utf-8", errors="replace") or "{}")
                    code = payload.get("code", response.status_code)
                    message = payload.get("msg") or response.reason_phrase or "Feishu download failed"
                    raise FeishuAPIError(f"{message} (code {code})")
                declared_size = int(response.headers.get("content-length", "0") or 0)
                if declared_size > limit:
                    raise FeishuAPIError(f"Download exceeds configured {limit}-byte limit")
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > limit:
                        raise FeishuAPIError(f"Download exceeds configured {limit}-byte limit")
                    chunks.append(chunk)
                disposition = response.headers.get("content-disposition", "")
        filename = ""
        match = re.search(r"filename\*?=(?:UTF-8''|\")?([^\";]+)", disposition, re.IGNORECASE)
        if match:
            filename = match.group(1).strip()
        return b"".join(chunks), content_type, filename

    def _save_download(self, data: bytes, filename: str, subfolder: str) -> Path:
        root = self.settings.download_dir.resolve()
        destination_dir = (root / safe_download_name(subfolder, "misc")).resolve()
        if root != destination_dir and root not in destination_dir.parents:
            raise ValueError("Download destination escaped configured root")
        destination_dir.mkdir(parents=True, exist_ok=True)
        destination = (destination_dir / safe_download_name(filename)).resolve()
        if destination_dir != destination.parent:
            raise ValueError("Download filename escaped configured directory")
        destination.write_bytes(data)
        return destination

    async def read_docx_raw_content(self, document_id_or_url: str) -> dict[str, str]:
        document_id = parse_docx_token(document_id_or_url)
        data = await self._request_json(
            "GET", f"/open-apis/docx/v1/documents/{document_id}/raw_content"
        )
        content = data.get("content", "")
        return {"document_id": document_id, "content": content}

    async def list_docx_blocks(
        self,
        document_id_or_url: str,
        page_size: int = 500,
        page_token: str = "",
    ) -> dict[str, Any]:
        """List one page of structured Docx blocks, including hyperlink metadata."""
        document_id = parse_docx_token(document_id_or_url)
        params: dict[str, Any] = {
            "document_revision_id": -1,
            "page_size": max(1, min(int(page_size), 500)),
        }
        if page_token.strip():
            params["page_token"] = page_token.strip()
        data = await self._request_json(
            "GET",
            f"/open-apis/docx/v1/documents/{document_id}/blocks",
            params=params,
        )
        return {
            "document_id": document_id,
            "blocks": data.get("items", []),
            "has_more": bool(data.get("has_more", False)),
            "next_page_token": data.get("page_token", ""),
        }

    async def list_drive_files(
        self,
        folder_token: str = "",
        page_size: int = 50,
        page_token: str = "",
    ) -> dict[str, Any]:
        """List one page of the user's Drive folder without recursing."""
        size = max(1, min(int(page_size), 200))
        params: dict[str, Any] = {
            "folder_token": folder_token.strip(),
            "page_size": size,
        }
        if page_token.strip():
            params["page_token"] = page_token.strip()
        data = await self._request_json(
            "GET", "/open-apis/drive/v1/files", params=params
        )
        return {
            "files": data.get("files", []),
            "has_more": bool(data.get("has_more", False)),
            "next_page_token": data.get("next_page_token", ""),
        }

    async def download_drive_file(self, file_token: str) -> bytes:
        """Download a Drive file that is readable by the authorized user."""
        normalized_token = _validate_identifier(file_token, "Drive file token")
        data, _, _ = await self._request_binary(
            f"/open-apis/drive/v1/medias/{normalized_token}/download"
        )
        return data

    async def download_drive_file_to_path(
        self, file_token: str, filename: str = ""
    ) -> dict[str, Any]:
        normalized_token = _validate_identifier(file_token, "Drive file token")
        data, content_type, response_name = await self._request_binary(
            f"/open-apis/drive/v1/medias/{normalized_token}/download"
        )
        final_name = filename or response_name or f"{normalized_token}.bin"
        path = self._save_download(data, final_name, "drive")
        return {
            "file_token": normalized_token,
            "path": str(path),
            "filename": path.name,
            "content_type": content_type,
            "bytes": len(data),
        }

    async def list_chats(
        self, page_size: int = 50, page_token: str = ""
    ) -> dict[str, Any]:
        """List chats visible through the authorized user/app access boundary."""
        params: dict[str, Any] = {
            "page_size": max(1, min(int(page_size), 100)),
            "user_id_type": "open_id",
        }
        if page_token.strip():
            params["page_token"] = page_token.strip()
        data = await self._request_json("GET", "/open-apis/im/v1/chats", params=params)
        return {
            "chats": data.get("items", []),
            "has_more": bool(data.get("has_more", False)),
            "next_page_token": data.get("page_token", ""),
        }

    async def list_messages(
        self,
        chat_id: str,
        start_time: str = "",
        end_time: str = "",
        sort_type: str = "ByCreateTimeAsc",
        page_size: int = 50,
        page_token: str = "",
    ) -> dict[str, Any]:
        """List one page of messages from a chat and normalize embedded references."""
        normalized_chat_id = _validate_identifier(chat_id, "chat ID")
        if sort_type not in {"ByCreateTimeAsc", "ByCreateTimeDesc"}:
            raise ValueError("sort_type must be ByCreateTimeAsc or ByCreateTimeDesc")
        params: dict[str, Any] = {
            "container_id_type": "chat",
            "container_id": normalized_chat_id,
            "sort_type": sort_type,
            "page_size": max(1, min(int(page_size), 50)),
        }
        if start_time.strip():
            params["start_time"] = start_time.strip()
        if end_time.strip():
            params["end_time"] = end_time.strip()
        if page_token.strip():
            params["page_token"] = page_token.strip()
        data = await self._request_json("GET", "/open-apis/im/v1/messages", params=params)
        return {
            "chat_id": normalized_chat_id,
            "messages": [normalize_message(item) for item in data.get("items", [])],
            "has_more": bool(data.get("has_more", False)),
            "next_page_token": data.get("page_token", ""),
        }

    async def get_message(self, message_id: str) -> dict[str, Any]:
        normalized_message_id = _validate_identifier(message_id, "message ID")
        data = await self._request_json(
            "GET", f"/open-apis/im/v1/messages/{normalized_message_id}"
        )
        items = data.get("items", [])
        return {
            "message": normalize_message(items[0]) if items else None,
            "found": bool(items),
        }

    async def download_message_resource(
        self,
        message_id: str,
        resource_key: str,
        resource_type: str,
        filename: str = "",
    ) -> dict[str, Any]:
        normalized_message_id = _validate_identifier(message_id, "message ID")
        normalized_resource_key = _validate_identifier(resource_key, "message resource key")
        normalized_type = resource_type.strip().lower()
        if normalized_type not in {"image", "file"}:
            raise ValueError("resource_type must be image or file")
        data, content_type, response_name = await self._request_binary(
            f"/open-apis/im/v1/messages/{normalized_message_id}/resources/"
            f"{normalized_resource_key}",
            params={"type": normalized_type},
        )
        extension = ".jpg" if normalized_type == "image" else ".bin"
        final_name = filename or response_name or f"{normalized_resource_key}{extension}"
        path = self._save_download(data, final_name, f"messages_{normalized_message_id}")
        return {
            "message_id": normalized_message_id,
            "resource_key": normalized_resource_key,
            "resource_type": normalized_type,
            "path": str(path),
            "filename": path.name,
            "content_type": content_type,
            "bytes": len(data),
        }

    async def search_docs(
        self,
        query: str,
        page_size: int = 20,
        page_token: str = "",
    ) -> dict[str, Any]:
        """Search documents and Wiki nodes visible to the authorized user."""
        normalized_query = query.strip()
        if not normalized_query:
            raise ValueError("Search query must not be empty")
        body: dict[str, Any] = {
            "query": normalized_query,
            "page_size": max(1, min(int(page_size), 50)),
        }
        if page_token.strip():
            body["page_token"] = page_token.strip()
        data = await self._request_json(
            "POST", "/open-apis/search/v2/doc_wiki/search", json=body
        )
        return {
            "total": int(data.get("total", 0)),
            "results": data.get("res_units", []),
            "has_more": bool(data.get("has_more", False)),
            "next_page_token": data.get("page_token", ""),
            "notice": data.get("notice", ""),
        }

    async def list_wiki_spaces(
        self,
        page_size: int = 50,
        page_token: str = "",
    ) -> dict[str, Any]:
        """List Wiki spaces visible to the currently authorized user."""
        params: dict[str, Any] = {
            "page_size": max(1, min(int(page_size), 50)),
        }
        if page_token.strip():
            params["page_token"] = page_token.strip()
        data = await self._request_json(
            "GET", "/open-apis/wiki/v2/spaces", params=params
        )
        return {
            "spaces": data.get("items", []),
            "has_more": bool(data.get("has_more", False)),
            "next_page_token": data.get("page_token", ""),
        }

    async def list_wiki_nodes(
        self,
        space_id: str,
        parent_node_token: str = "",
        page_size: int = 50,
        page_token: str = "",
    ) -> dict[str, Any]:
        """List one page of direct children in a Wiki space."""
        normalized_space_id = space_id.strip()
        if not normalized_space_id:
            raise ValueError("Wiki space ID must not be empty")
        params: dict[str, Any] = {
            "page_size": max(1, min(int(page_size), 50)),
        }
        if parent_node_token.strip():
            params["parent_node_token"] = parent_node_token.strip()
        if page_token.strip():
            params["page_token"] = page_token.strip()
        data = await self._request_json(
            "GET",
            f"/open-apis/wiki/v2/spaces/{normalized_space_id}/nodes",
            params=params,
        )
        return {
            "nodes": data.get("items", []),
            "has_more": bool(data.get("has_more", False)),
            "next_page_token": data.get("page_token", ""),
        }

    async def get_wiki_node(self, node_token: str) -> dict[str, Any]:
        normalized_token = _validate_identifier(node_token, "Wiki node token")
        data = await self._request_json(
            "GET",
            "/open-apis/wiki/v2/spaces/get_node",
            params={"token": normalized_token, "obj_type": "wiki"},
        )
        return data.get("node", data)

    async def list_bitable_tables(
        self,
        app_token_or_url: str,
        page_size: int = 100,
        page_token: str = "",
    ) -> dict[str, Any]:
        app_token = parse_bitable_token(app_token_or_url)
        params: dict[str, Any] = {"page_size": max(1, min(int(page_size), 100))}
        if page_token.strip():
            params["page_token"] = page_token.strip()
        data = await self._request_json(
            "GET", f"/open-apis/bitable/v1/apps/{app_token}/tables", params=params
        )
        return {
            "app_token": app_token,
            "tables": data.get("items", []),
            "has_more": bool(data.get("has_more", False)),
            "next_page_token": data.get("page_token", ""),
        }

    async def list_bitable_records(
        self,
        app_token_or_url: str,
        table_id: str,
        view_id: str = "",
        page_size: int = 100,
        page_token: str = "",
    ) -> dict[str, Any]:
        app_token = parse_bitable_token(app_token_or_url)
        normalized_table_id = _validate_identifier(table_id, "Bitable table ID")
        params: dict[str, Any] = {"page_size": max(1, min(int(page_size), 500))}
        if view_id.strip():
            params["view_id"] = _validate_identifier(view_id, "Bitable view ID")
        if page_token.strip():
            params["page_token"] = page_token.strip()
        data = await self._request_json(
            "GET",
            f"/open-apis/bitable/v1/apps/{app_token}/tables/"
            f"{normalized_table_id}/records",
            params=params,
        )
        return {
            "app_token": app_token,
            "table_id": normalized_table_id,
            "records": data.get("items", []),
            "total": data.get("total", 0),
            "has_more": bool(data.get("has_more", False)),
            "next_page_token": data.get("page_token", ""),
        }

    async def resolve_feishu_url(self, url: str) -> dict[str, Any]:
        parsed = urlparse(url.strip())
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("Expected an absolute Feishu URL")
        hostname = parsed.hostname.lower()
        if hostname != "feishu.cn" and not hostname.endswith(".feishu.cn"):
            raise ValueError("URL is not hosted on feishu.cn")
        parts = [part for part in parsed.path.split("/") if part]
        if len(parts) < 2:
            raise ValueError("Feishu URL does not contain a supported object token")
        kind, token = parts[0], _validate_identifier(parts[1], "Feishu object token")
        query = parse_qs(parsed.query)
        if kind == "docx":
            return {"kind": "docx", **await self.read_docx_raw_content(token)}
        if kind == "wiki":
            node = await self.get_wiki_node(token)
            result: dict[str, Any] = {"kind": "wiki", "node": node}
            if node.get("obj_type") == "docx" and node.get("obj_token"):
                result["document"] = await self.read_docx_raw_content(str(node["obj_token"]))
            return result
        if kind == "sheets":
            return {
                "kind": "sheets",
                "spreadsheet_token": token,
                "sheet_id": (query.get("sheet") or [""])[0],
                "notice": "Call read_sheet_range with an explicit cell range to retrieve values.",
            }
        if kind == "base":
            result = {"kind": "bitable", "app_token": token}
            table_id = (query.get("table") or [""])[0]
            view_id = (query.get("view") or [""])[0]
            if table_id:
                result["records"] = await self.list_bitable_records(
                    token, table_id, view_id=view_id, page_size=100
                )
            else:
                result["tables"] = await self.list_bitable_tables(token)
            return result
        if kind in {"file", "mindnotes", "slides"}:
            return {
                "kind": kind,
                "file_token": token,
                "notice": "Metadata resolved. Use download_drive_file for readable Drive binaries.",
            }
        raise ValueError(f"Unsupported Feishu URL type: {kind}")

    async def read_sheet_range(
        self, spreadsheet_token_or_url: str, cell_range: str
    ) -> dict[str, Any]:
        """Read a rectangular Feishu Sheets range without changing cells."""
        spreadsheet_token = parse_sheet_token(spreadsheet_token_or_url)
        normalized_range = cell_range.strip()
        if not normalized_range:
            raise ValueError("Sheet range must not be empty")
        encoded_range = quote(normalized_range, safe="!:_-$")
        data = await self._request_json(
            "GET",
            f"/open-apis/sheets/v2/spreadsheets/{spreadsheet_token}/values/"
            f"{encoded_range}",
        )
        value_range = data.get("valueRange", data.get("value_range", {}))
        return {
            "spreadsheet_token": spreadsheet_token,
            "range": value_range.get("range", normalized_range),
            "values": value_range.get("values", []),
        }
