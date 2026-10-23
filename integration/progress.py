"""Private, bounded progress events; no message bodies or secrets."""
import json,sys,time
STAGES=('准备数据','检测连接','采集消息','解析附件','解析图片','请求 AI','保存结果','完成','失败')
def emit(stage,done=None,total=None,detail=''):
    if stage not in STAGES:return
    value={'stage':stage,'at':time.time(),'done':done,'total':total,'detail':detail[:160]}
    sys.stderr.write('WS_PROGRESS '+json.dumps(value,ensure_ascii=True)+'\n');sys.stderr.flush()

