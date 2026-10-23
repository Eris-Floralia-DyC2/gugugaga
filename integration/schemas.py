"""Versioned normalized message schema; reject invalid records before cursor commit."""
from typing import Literal
from pydantic import BaseModel,ConfigDict,Field


class Attachment(BaseModel):
    model_config=ConfigDict(extra='allow',strict=True)
    kind:str=Field(min_length=1,max_length=100)
    stages:dict[str,str]


class Message(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    id:str=Field(min_length=1,max_length=200)
    schema_version:Literal[1]
    platform:Literal['wechat','feishu','qq']
    source_id:str=Field(min_length=1,max_length=80)
    account_id:str=Field(min_length=1,max_length=200)
    chat_id:str=Field(min_length=1,max_length=200)
    chat_name:str=Field(max_length=2000)
    message_id:str=Field(min_length=1,max_length=400)
    sender_id:str=Field(max_length=400)
    sender_name:str=Field(max_length=2000)
    timestamp:int=Field(ge=0,le=253402300799)
    timezone:Literal['Asia/Shanghai']
    message_type:int|str
    content:str=Field(max_length=120000)
    attachments:list[Attachment]=Field(max_length=100)
    reply_to:dict|str|None
    parse_status:str=Field(max_length=100)
    raw_reference:dict
    truncated:bool
