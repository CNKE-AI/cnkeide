<?php
/**
 * CnkeIDE 远程配置接口（内置 API + 远程公告）
 * 部署位置：/www/wwwroot/ai.cnkes.cn/cnkeide/config/api.php
 * 配置数据：/www/wwwroot/ai.cnkes.cn/cnkeide/config/config.json
 *
 * 鉴权：
 *   登录      POST api.php?action=login     body: JSON { username, password }
 *            验证通过返回 { success:true, token:<ADMIN_TOKEN> }
 *   其余接口  POST/GET 需携带 token=<ADMIN_TOKEN>
 *
 * 接口：
 *   获取全部内置 API   GET api.php?action=get&token=<T>
 *   新增内置 API       POST api.php?action=add&token=<T>      body: { name, model, baseUrl, apiKey, provider? }
 *   更新内置 API       POST api.php?action=update&token=<T>    body: { id, ...字段 }
 *   删除内置 API       POST api.php?action=remove&token=<T>    body: { id }
 *   获取公告(客户端)   GET api.php?action=announcements        （无需 token，公开读取）
 *   公告列表(管理)     GET api.php?action=ann_list&token=<T>
 *   保存公告(管理)     POST api.php?action=ann_save&token=<T>   body: { id?, title, content, type, platform?, minVersion?, maxVersion?, startAt?, endAt?, enabled, once }
 *   删除公告(管理)     POST api.php?action=ann_delete&token=<T>  body: { id }
 *   健康检查           GET api.php?action=ping
 */
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

const ADMIN_USER = '1103303578';
const ADMIN_PASS = '19951210';
const ADMIN_TOKEN = 'cnkeide_cfg_2026_admin';
const CONFIG_FILE = __DIR__ . '/config.json';

function now_ms(): int { return (int)round(microtime(true) * 1000); }
function fail(string $m, int $c = 400): void { http_response_code($c); echo json_encode(['success'=>false,'error'=>$m]); exit; }
function ok(array $d = []): void { echo json_encode(array_merge(['success'=>true], $d)); exit; }

function load_config(): array {
    if (!file_exists(CONFIG_FILE)) {
        return ['builtins' => [], 'announcements' => []];
    }
    $raw = file_get_contents(CONFIG_FILE);
    $data = json_decode($raw, true);
    if (!is_array($data)) return ['builtins' => [], 'announcements' => []];
    if (!isset($data['builtins']) || !is_array($data['builtins'])) {
        // 兼容旧的单内置配置 builtin
        if (isset($data['builtin']) && is_array($data['builtin'])) {
            $data['builtins'] = [$data['builtin']];
        } else {
            $data['builtins'] = [];
        }
    }
    if (!isset($data['announcements']) || !is_array($data['announcements'])) {
        $data['announcements'] = [];
    }
    return $data;
}

function save_config(array $data): bool {
    // 同步 builtin 兼容字段 = 第一个内置 API
    $data['builtin'] = $data['builtins'][0] ?? null;
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    if (file_put_contents(CONFIG_FILE, $json, LOCK_EX) === false) return false;
    @chmod(CONFIG_FILE, 0664);
    return true;
}

function body_json(): array {
    $raw = file_get_contents('php://input');
    $body = json_decode($raw, true);
    return is_array($body) ? $body : [];
}

function need_token(): void {
    if (($_REQUEST['token'] ?? '') !== ADMIN_TOKEN) fail('未授权', 403);
}

/** 客户端公开读取的公告过滤（启用 + 时间窗 + 平台 + 版本范围） */
function filter_announcements(array $list, string $version, string $platform): array {
    $now = date('Y-m-d H:i:s');
    $out = [];
    foreach ($list as $item) {
        if (empty($item['enabled'])) continue;
        if (!empty($item['startAt']) && $item['startAt'] > $now) continue;
        if (!empty($item['endAt']) && $item['endAt'] <= $now) continue;
        $plat = strtolower($item['platform'] ?? 'all');
        if ($plat !== 'all' && $plat !== strtolower($platform)) continue;
        if (!empty($item['minVersion']) && version_compare($version, $item['minVersion'], '<')) continue;
        if (!empty($item['maxVersion']) && version_compare($version, $item['maxVersion'], '>')) continue;
        $out[] = [
            'id' => $item['id'] ?? '',
            'title' => $item['title'] ?? '',
            'content' => $item['content'] ?? '',
            'type' => $item['type'] ?? 'info',
            'once' => !empty($item['once']),
            'createdAt' => $item['createdAt'] ?? '',
        ];
    }
    usort($out, function($a, $b) { return strcmp($b['createdAt'], $a['createdAt']); });
    return $out;
}

$action = $_REQUEST['action'] ?? 'get';

switch ($action) {
    case 'login': {
        $b = body_json();
        $u = trim($b['username'] ?? '');
        $p = trim($b['password'] ?? '');
        if ($u === ADMIN_USER && $p === ADMIN_PASS) {
            ok(['token' => ADMIN_TOKEN, 'user' => $u]);
        }
        fail('账号或密码错误', 401);
        break;
    }

    case 'get':
        // 内置 API 配置是给客户端公开读取的（无 token 可读），仅管理操作需鉴权
        $cfg = load_config();
        $builtins = $cfg['builtins'];
        ok(['builtins' => $builtins, 'builtin' => $builtins[0] ?? null, 'serverTime' => now_ms()]);
        break;

    case 'add': {
        need_token();
        $b = body_json();
        $name = trim($b['name'] ?? '');
        $model = trim($b['model'] ?? '');
        $baseUrl = trim($b['baseUrl'] ?? '');
        $apiKey = trim($b['apiKey'] ?? '');
        if ($name === '' || $model === '' || $baseUrl === '' || $apiKey === '') {
            fail('name、model、baseUrl、apiKey 不能为空');
        }
        $cfg = load_config();
        $item = [
            'id' => 'builtin_' . substr(md5(uniqid('', true)), 0, 8),
            'name' => $name,
            'provider' => trim($b['provider'] ?? 'openai_compatible'),
            'model' => $model,
            'baseUrl' => $baseUrl,
            'apiKey' => $apiKey,
        ];
        $cfg['builtins'][] = $item;
        if (!save_config($cfg)) fail('写入失败', 500);
        ok(['item' => $item]);
        break;
    }

    case 'update': {
        need_token();
        $b = body_json();
        $id = trim($b['id'] ?? '');
        if ($id === '') fail('id 不能为空');
        $cfg = load_config();
        $found = false;
        foreach ($cfg['builtins'] as &$it) {
            if ($it['id'] === $id) {
                foreach (['name','provider','model','baseUrl','apiKey'] as $k) {
                    if (isset($b[$k]) && $b[$k] !== '') {
                        $it[$k] = $b[$k];
                    }
                }
                $found = true;
                $updated = $it;
                break;
            }
        }
        unset($it);
        if (!$found) fail('未找到该内置 API', 404);
        if (!save_config($cfg)) fail('写入失败', 500);
        ok(['item' => $updated]);
        break;
    }

    case 'remove': {
        need_token();
        $b = body_json();
        $id = trim($b['id'] ?? '');
        if ($id === '') fail('id 不能为空');
        $cfg = load_config();
        $newList = array_values(array_filter($cfg['builtins'], function($it) use ($id) {
            return ($it['id'] ?? '') !== $id;
        }));
        if (count($newList) === count($cfg['builtins'])) fail('未找到该内置 API', 404);
        $cfg['builtins'] = $newList;
        if (!save_config($cfg)) fail('写入失败', 500);
        ok(['removed' => $id]);
        break;
    }

    // ==================== 公告 ====================

    case 'announcements': {
        // 客户端公开读取
        $cfg = load_config();
        $version = $_GET['version'] ?? '';
        $platform = $_GET['platform'] ?? 'win';
        $list = filter_announcements($cfg['announcements'], $version, $platform);
        ok(['announcements' => $list, 'serverTime' => now_ms()]);
        break;
    }

    case 'ann_list': {
        need_token();
        $cfg = load_config();
        // 管理列表返回全部（含禁用），按创建时间倒序
        $list = $cfg['announcements'];
        usort($list, function($a, $b) { return strcmp($b['createdAt'] ?? '', $a['createdAt'] ?? ''); });
        ok(['announcements' => $list]);
        break;
    }

    case 'ann_save': {
        need_token();
        $b = body_json();
        $title = trim($b['title'] ?? '');
        $content = trim($b['content'] ?? '');
        if ($title === '' || $content === '') fail('标题和内容不能为空');
        $cfg = load_config();
        $id = trim($b['id'] ?? '');
        if ($id === '') {
            // 新增
            $item = [
                'id' => 'ann_' . substr(md5(uniqid('', true)), 0, 8),
                'title' => $title,
                'content' => $content,
                'type' => in_array($b['type'] ?? '', ['info','warning','urgent']) ? $b['type'] : 'info',
                'platform' => trim($b['platform'] ?? 'all'),
                'minVersion' => trim($b['minVersion'] ?? ''),
                'maxVersion' => trim($b['maxVersion'] ?? ''),
                'startAt' => trim($b['startAt'] ?? ''),
                'endAt' => trim($b['endAt'] ?? ''),
                'enabled' => !empty($b['enabled']),
                'once' => !empty($b['once']),
                'createdAt' => date('Y-m-d H:i:s'),
                'updatedAt' => date('Y-m-d H:i:s'),
            ];
            $cfg['announcements'][] = $item;
        } else {
            // 更新
            $found = false;
            foreach ($cfg['announcements'] as &$it) {
                if ($it['id'] === $id) {
                    $it['title'] = $title;
                    $it['content'] = $content;
                    $it['type'] = in_array($b['type'] ?? '', ['info','warning','urgent']) ? $b['type'] : 'info';
                    $it['platform'] = trim($b['platform'] ?? 'all');
                    $it['minVersion'] = trim($b['minVersion'] ?? '');
                    $it['maxVersion'] = trim($b['maxVersion'] ?? '');
                    $it['startAt'] = trim($b['startAt'] ?? '');
                    $it['endAt'] = trim($b['endAt'] ?? '');
                    $it['enabled'] = !empty($b['enabled']);
                    $it['once'] = !empty($b['once']);
                    $it['updatedAt'] = date('Y-m-d H:i:s');
                    $found = true;
                    $item = $it;
                    break;
                }
            }
            unset($it);
            if (!$found) fail('未找到该公告', 404);
        }
        if (!save_config($cfg)) fail('写入失败', 500);
        ok(['item' => $item]);
        break;
    }

    case 'ann_delete': {
        need_token();
        $b = body_json();
        $id = trim($b['id'] ?? '');
        if ($id === '') fail('id 不能为空');
        $cfg = load_config();
        $newList = array_values(array_filter($cfg['announcements'], function($it) use ($id) {
            return ($it['id'] ?? '') !== $id;
        }));
        if (count($newList) === count($cfg['announcements'])) fail('未找到该公告', 404);
        $cfg['announcements'] = $newList;
        if (!save_config($cfg)) fail('写入失败', 500);
        ok(['removed' => $id]);
        break;
    }

    // ==================== 公告 SSE 实时推送 ====================
    case 'stream': {
        // 覆盖为 SSE 流式响应（覆盖开头的 application/json）
        header('Content-Type: text/event-stream; charset=utf-8');
        header('Cache-Control: no-cache');
        header('Connection: keep-alive');
        header('X-Accel-Buffering: no');
        header('Access-Control-Allow-Origin: *');

        if (function_exists('apache_setenv')) { @apache_setenv('no-gzip', '1'); }
        @ini_set('zlib.output_compression', '0');
        @ini_set('implicit_flush', '1');
        @ini_set('output_buffering', '0');
        while (ob_get_level() > 0) { @ob_end_flush(); }

        $version = $_GET['version'] ?? '';
        $platform = $_GET['platform'] ?? 'win';

        // 用 filemtime + 公告内容 hash 作为变更指纹
        $lastMtime = null;
        $lastHash = null;

        // 最长连接时长（秒），到期由客户端重连。
        // 需小于 php-fpm 的 request_terminate_timeout（当前 100s），留余量取 85s。
        $maxSeconds = 85;
        $heartbeat = 15;
        $started = time();

        // 首次连接先推送一份当前公告快照
        $emit = function(string $event, array $payload) {
            echo 'event: ' . $event . "\n";
            echo 'data: ' . json_encode($payload, JSON_UNESCAPED_UNICODE) . "\n\n";
            if (function_exists('fastcgi_finish_request')) { /* SSE 不能提前结束 */ }
            @flush();
        };

        $emit('ready', ['serverTime' => now_ms()]);

        while (true) {
            // 超时主动断开，让客户端重连
            if ((time() - $started) >= $maxSeconds) {
                $emit('timeout', ['serverTime' => now_ms()]);
                break;
            }

            clearstatcache(true, CONFIG_FILE);
            $mtime = file_exists(CONFIG_FILE) ? @filemtime(CONFIG_FILE) : 0;
            $raw = file_exists(CONFIG_FILE) ? (string)@file_get_contents(CONFIG_FILE) : '';
            $hash = md5($raw);

            // 检测到配置变化 → 重新过滤并推送公告
            if ($mtime !== $lastMtime || $hash !== $lastHash) {
                $lastMtime = $mtime;
                $lastHash = $hash;
                $cfg = load_config();
                $list = filter_announcements($cfg['announcements'], $version, $platform);
                $emit('announcements', ['announcements' => $list, 'serverTime' => now_ms()]);
            } else {
                // 心跳保活
                $emit('ping', ['serverTime' => now_ms()]);
            }

            if (connection_aborted()) break;
            sleep($heartbeat);
        }
        break;
    }

    case 'ping':
        ok(['pong' => true]);
        break;

    default:
        fail('未知 action');
}
