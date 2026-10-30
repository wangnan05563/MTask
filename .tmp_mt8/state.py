import sys, json, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mt import tool, rpc

CMD = sys.argv[1]
NUMBERS = sys.argv[2].split(',')
STAGE = sys.argv[3] if len(sys.argv) > 3 else '八期批次2 前端'

for no in NUMBERS:
    if CMD == 'running':
        r = rpc('mtask_update_task_status', {'taskNo': no, 'state': 'running'})
        p = rpc('mtask_report_progress', {'platform': 'qoder', 'task_id': no, 'session_id': f'batch2-{no}',
                                          'phase': STAGE, 'pct': 5})
        print(no, 'status:', (r or '')[:60], '| progress:', (p or '')[:60])
    elif CMD == 'done':
        p = rpc('mtask_report_progress', {'platform': 'qoder', 'task_id': no, 'session_id': f'batch2-{no}',
                                          'phase': STAGE, 'pct': 100, 'done': True})
        print(no, 'progress done:', (p or '')[:60])
