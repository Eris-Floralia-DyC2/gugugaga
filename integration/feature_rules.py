"""Separate feature settings, falling back to the existing shared prompt."""
from state import read_json,atomic_json,UserError

def validate(value):
    if not isinstance(value,dict) or set(value)!={'version','summary','tasks'} or value['version']!=1:raise UserError('AI 功能设置格式无效')
    for key in ('summary','tasks'):
        item=value[key]
        if not isinstance(item,dict) or set(item)!={'instructions','max_tokens'} or not isinstance(item['instructions'],str) or len(item['instructions'])>8000:raise UserError('每项附加提示词最多 8000 字符')
        if type(item['max_tokens']) is not int or not 256<=item['max_tokens']<=32768:raise UserError('每项输出上限需为 256–32768 的整数，且不能超过所用模型的支持范围')
    return value

def settings(state):
    legacy=read_json(state.root/'config/rules/analysis.json',{}).get('instructions','')
    return validate(read_json(state.root/'config/rules/ai-features.json',{'version':1,'summary':{'instructions':legacy,'max_tokens':4096},'tasks':{'instructions':legacy,'max_tokens':4096}}))

def save(state,value):
    atomic_json(state.root/'config/rules/ai-features.json',validate(value))
    return {'saved':True}

def disclosure():
    from summaries import SYSTEM as summary
    from proposal_rules import SYSTEM as tasks
    return {'summary':summary,'tasks':tasks,'notes':'附加提示词追加在内置要求之后。请求使用 JSON 输出和短来源编号；来源原文仍须通过程序核对。总结读取最近 200 条索引消息，任务分析每批最多 40 条，两者各有约 6 万字符输入预算。来源校验失败时，对同一批消息最多进行一次修正请求。输出上限只控制返回 Token 数，不会增加输入消息范围。图片识别和连接测试使用各自的请求设置。'}
