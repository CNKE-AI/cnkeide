# -*- coding: utf-8 -*-
"""给 ai.cnkes.cn.conf 末尾（access_log 前）插入 SSE 反缓冲 location"""
import paramiko

HOST = '103.236.72.232'
USER = 'root'
PWD = 'B]3u$iESeZ*0'

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username=USER, password=PWD, timeout=25)

conf = '/www/server/panel/vhost/nginx/ai.cnkes.cn.conf'

# 读取当前 conf
sftp = c.open_sftp()
with sftp.open(conf, 'r') as f:
    content = f.read().decode('utf-8')
sftp.close()

anchor = "    access_log  /www/wwwlogs/ai.cnkes.cn.log;"
if anchor not in content:
    print('ERROR: 未找到 access_log 锚点')
    c.close()
    raise SystemExit(1)

sse_location = '''    # SSE 实时公告推送（无缓冲，避免 nginx 缓冲导致事件延迟）
    location ~ ^/cnkeide/config/api\\.php$ {
        include enable-php-82.conf;
        fastcgi_buffering off;
        fastcgi_request_buffering off;
        gzip off;
        proxy_buffering off;
        fastcgi_read_timeout 100s;
    }

'''

if 'fastcgi_buffering off;' in content:
    print('已存在反缓冲配置，跳过插入')
else:
    new_content = content.replace(anchor, sse_location + anchor, 1)
    # 备份
    bak = conf + '.bak_sse_20260904'
    i, o, e = c.exec_command(f'cp {conf} {bak}')
    o.read(); e.read()
    sftp = c.open_sftp()
    with sftp.open(conf, 'w') as f:
        f.write(new_content.encode('utf-8'))
    sftp.close()
    print('已插入 SSE location，备份：' + bak)

# 校验 nginx 语法 + reload
print('=== nginx -t ===')
i, o, e = c.exec_command('nginx -t 2>&1')
print(o.read().decode(errors='replace'))
print(e.read().decode(errors='replace'))

print('=== nginx reload ===')
i, o, e = c.exec_command('nginx -s reload 2>&1')
print(o.read().decode(errors='replace'))
print(e.read().decode(errors='replace'))

c.close()
print('DONE')
