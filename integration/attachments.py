import hashlib
import mimetypes
import re
from pathlib import Path
from PIL import Image
from state import UserError, digest
from documents import extract
from decode_image import decrypt_dat_file, extract_md5_from_packed_info


def process_file(state,a,path,source_id,fingerprint=None,strict=False):
    """Shared parsers for already readable WeChat and QCE document/image files."""
    stage='located'
    try:
        path=Path(path)
        if not path.is_file() or path.stat().st_size>64*1024*1024:raise UserError('附件缺失或大于 64MB')
        a['local_file']=str(path);a['stages']['located']='ok'
        a['mime_type']=mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
        with path.open('rb') as stream:file_hash=hashlib.file_digest(stream,'sha256').hexdigest()
        a['source_fingerprint']=fingerprint or digest(['readable-files-v1',str(path),file_hash])
        if a['kind']=='document':
            stage='extracted';result=extract(path)
            a.update(extracted_text=result['text'],truncated=result['truncated'],detected_type=result['type'])
            a['stages']['decrypted']='not_needed_or_unsupported';a['stages']['extracted']='ok'
        elif a['kind']=='image':
            stage='validated'
            target=state.root/'cache/attachments'/source_id/(a['id']+'.image')
            target.parent.mkdir(parents=True,exist_ok=True)
            __import__('shutil').copyfile(path,target)
            with Image.open(target) as image:image.verify()
            a['decoded_file']=str(target);a['stages'].update(decrypted='ok',validated='ok',vision='not_authorized_or_unsupported')
        else:raise UserError('此类附件尚未完整解析')
        a.pop('error',None)
    except Exception as e:
        if strict:raise
        a['stages'][stage]='failed';a['error']=str(e)[:200] if isinstance(e,UserError) else '附件处理失败：'+type(e).__name__
    return a


class Attachments:
    def __init__(self,state,adapter):
        self.state,self.adapter=state,adapter
        self.base=adapter.root.parent.resolve()
        self.out=state.root/'cache/attachments'/adapter.source['id']
        self.out.mkdir(parents=True,exist_ok=True)
        self.config=state.config()

    def locate(self,message,a):
        md5=a.get('md5','')
        resources=self.adapter.resources(message)
        candidates=[md5]
        for r in resources:
            candidates.insert(0,extract_md5_from_packed_info(r.get('packed_info')) or '')
        folder=self.base/'msg/attach'/hashlib.md5(message['chat_id'].encode()).hexdigest()
        found=[]
        for md5 in candidates:
            if re.fullmatch('[0-9a-fA-F]{32}',md5):
                found=[p for p in folder.glob(f'*/*/{md5}*') if p.is_file()]
                if found: break
        if not found:
            for r in resources:
                for d in r.get('details',[]):
                    index=d.get('data_index','')
                    if isinstance(index,str) and index:
                        candidate=(self.base/index.replace('\\','/')).resolve()
                        if candidate.is_relative_to(self.base) and candidate.is_file(): found.append(candidate)
        name=a.get('name','')
        if not found and name and Path(name).name==name and not any(c in name for c in '*?[]\\/'):
            # A filename is only a fallback within the exact chat and message month.
            from datetime import datetime,timezone,timedelta
            month=datetime.fromtimestamp(message['timestamp'],timezone(timedelta(hours=8))).strftime('%Y-%m')
            found=[p for p in (folder/month).glob(f'*/{name}') if p.is_file()]
            if not found and resources:
                # WeChat also stores regular files in account/msg/file/YYYY-MM.
                # Require the message-bound resource's exact size, and a unique file.
                sizes={d.get('size') for r in resources for d in r.get('details',[]) if d.get('size')}
                found=[p for p in (self.base/'msg/file'/month).glob(name) if p.is_file() and p.stat().st_size in sizes]
        found=[p.resolve() for p in found if p.resolve().is_relative_to(self.base)]
        if len(found)>1 and a['kind']=='image':
            # Same MD5 variants are the same attachment; prefer high resolution.
            found.sort(key=lambda p:(p.stem.endswith('_t'),not p.stem.endswith('_h')))
            found=found[:1]
        if len(found)!=1:
            raise UserError('附件未下载、关联索引缺失或存在多个候选，未猜测文件')
        return found[0]

    def process(self,message):
        with self.state.db() as con:
            previous=con.execute('SELECT payload FROM messages WHERE id=? AND source=?',(message['id'],self.adapter.source['id'])).fetchone()
        import json
        old={a.get('id'):a for a in json.loads(previous[0])['attachments']} if previous else {}
        for i,a in enumerate(message['attachments']):
            a['id']=digest([message['id'],i])
            a['source_message']=message['id']
            stages=a['stages']
            stage='located'
            try:
                if a['kind']=='audio':
                    a.clear();a.update(kind='audio',id=digest([message['id'],i]),source_message=message['id'],stages={'identified':'ok','processed':'unprocessed'},error='语音未处理')
                    continue
                path=self.locate(message,a)
                a['local_file']=str(path)
                stages['located']='ok'
                a['mime_type']=mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
                if path.stat().st_size>64*1024*1024:raise UserError('附件大于 64MB')
                with path.open('rb') as stream:file_hash=hashlib.file_digest(stream,'sha256').hexdigest()
                media=self.state.secret('media-'+self.adapter.source['id']) or {} if a['kind']=='image' else {}
                version=digest(['parsers-v2-no-voice',str(path),file_hash,media])
                prior=old.get(a['id'],{})
                ready={'document':'extracted','image':'validated','audio':'decoded'}.get(a['kind'])
                if (prior.get('source_fingerprint')==version and not prior.get('error') and ready
                        and prior.get('stages',{}).get(ready)=='ok'
                        and (a['kind']=='document' or __import__('pathlib').Path(prior.get('decoded_file','')).is_file())):
                    a.clear();a.update(prior)
                    if a['stages'].get('vision')=='failed':
                        a['stages']['vision']='retry';a.pop('vision_error',None)
                    continue
                a['source_fingerprint']=version
                if a['kind']=='document':
                    stage='extracted'
                    process_file(self.state,a,path,self.adapter.source['id'],fingerprint=version,strict=True)
                elif a['kind']=='image':
                    stage='decrypted'
                    if path.stat().st_size>64*1024*1024:
                        raise UserError('图片大于 64MB')
                    target=self.out/(a['id']+'.image')
                    media=self.state.secret('media-'+self.adapter.source['id']) or {}
                    key=bytes.fromhex(media['aes_key']) if media.get('aes_key') else None
                    with path.open('rb') as f:
                        header=f.read(8)
                    if path.suffix.lower()=='.dat':
                        result,fmt=decrypt_dat_file(str(path),str(target),key,media.get('xor_key',0x88))
                        if not result:
                            raise UserError('图片解密失败或缺少独立图片密钥')
                        if fmt=='hevc':
                            original=self.out/(a['id']+'.wxgf')
                            target.replace(original);a['original_decoded_file']=str(original)
                            thumb=path.with_name(path.stem.removesuffix('_h')+'_t.dat')
                            if not thumb.is_file():raise UserError('原图为 wxgf/HEVC，且本地没有可用缩略图')
                            result,fmt=decrypt_dat_file(str(thumb),str(target),key,media.get('xor_key',0x88))
                            if not result:raise UserError('原图 wxgf 已解密，缩略图暂不可用')
                            a['resolution']='thumbnail';a['original_format']='wxgf'
                    else:
                        import shutil
                        shutil.copyfile(path,target)
                    with Image.open(target) as image:
                        image.verify()
                    a['decoded_file']=str(target)
                    stages['decrypted']='ok'
                    stages['validated']='ok'
                    stages['vision']='not_authorized_or_unsupported'
                else:
                    stages['extracted']='unsupported'
                a.pop('error',None)
            except Exception as e:
                stages[stage]='failed'
                # Exceptions from parsers may include private text; keep bounded safe categories.
                a['error']=str(e)[:200] if isinstance(e,UserError) else '附件处理失败：'+type(e).__name__
        return message
