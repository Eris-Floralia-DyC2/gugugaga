"""Safe source status; no message content, paths, tokens, or provider response bodies."""
import time
from state import read_json, atomic_json


def update(state, sid, stage, ok, reason='', requires_auth=False):
    file=state.root/f'state/health-{sid}.json'
    value=read_json(file,{})
    value.update(stage=stage,ok=ok,checked_at=time.time(),reason=reason[:350],requires_auth=requires_auth)
    if ok:value['last_'+stage]=time.time()
    atomic_json(file,value)
    return value
