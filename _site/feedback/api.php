<?php
/**
 * CnkeIDE 反馈服务 API
 * 部署位置：/www/wwwroot/ai.cnkes.cn/feedback/api.php
 * 数据目录：/www/wwwroot/ai.cnkes.cn/feedback/data/
 *
 * 接口：
 *   提交反馈    POST api.php  action=submit&device=<id>&msg=<内容>&contact=<联系方式可选>&version=<客户端版本可选>
 *   拉取设备反馈 GET  api.php  action=list&device=<id>&since=<时间戳可选>
 *   管理列表    GET  api.php  action=admin_list&token=<ADMIN_TOKEN>
 *   管理员回复   POST api.php  action=reply&token=<ADMIN_TOKEN>&device=<id>&msg_id=<id>&content=<回复>
 *   管理未读数   GET  api.php  action=admin_count&token=<ADMIN_TOKEN>
 */
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

/** 管理员鉴权
 *
 * 三套凭据都接受：
 *   1) 统一后台（cnkeide/config）登录后签发的 HMAC token —— 首选，随登录态 24h 过期，
 *      后台「反馈管理」面板直接带着它调用，无需再手动输入专用 token；
 *   2) 反馈专用固定 token（旧链接/脚本/浏览器 localStorage 里已存的仍可用）；
 *   3) 旧配置专用固定 token（历史兼容）。
 */
const ADMIN_TOKEN  = 'cnkeide_fb_2026_admin';
const ADMIN_TOKEN2 = 'cnkeide_cfg_2026_admin';

/** 统一后台的签名密钥文件（与 cnkeide/config/api.php 共用，只读） */
const CFG_SECRET_FILE = __DIR__ . '/../cnkeide/config/.secret.json';

function safe_eq(string $a, string $b): bool {
    if ($a === '' || $b === '') return false;
    if (strlen($a) !== strlen($b)) return false;
    return hash_equals($a, $b);
}

/** 校验 cnkeide/config 后台签发的 token：base64(payload).hmac_sha256 */
function verify_cfg_token(string $token): bool {
    if ($token === '' || !file_exists(CFG_SECRET_FILE) || !is_readable(CFG_SECRET_FILE)) return false;
    $raw = @file_get_contents(CFG_SECRET_FILE);
    $secret = json_decode((string)$raw, true);
    if (!is_array($secret) || empty($secret['signKey'])) return false;

    $parts = explode('.', $token, 2);
    if (count($parts) !== 2) return false;
    [$payload, $sig] = $parts;

    $expect = hash_hmac('sha256', $payload, (string)$secret['signKey']);
    if (!safe_eq($expect, $sig)) return false;

    $data = json_decode((string)base64_decode($payload, true), true);
    if (!is_array($data)) return false;
    return (int)($data['e'] ?? 0) >= time();   // 过期即失效
}

function is_admin(): bool {
    $t = (string)($_REQUEST['token'] ?? $_SERVER['HTTP_X_AUTH_TOKEN'] ?? '');
    if ($t === '') return false;
    if (safe_eq($t, ADMIN_TOKEN) || safe_eq($t, ADMIN_TOKEN2)) return true;
    return verify_cfg_token($t);
}

/** 数据目录 */
const DATA_DIR = __DIR__ . '/data/';

function now_ms(): int {
    return (int)round(microtime(true) * 1000);
}

function fail(string $msg, int $code = 400): void {
    http_response_code($code);
    echo json_encode(['success' => false, 'error' => $msg]);
    exit;
}

function ok(array $data = []): void {
    echo json_encode(array_merge(['success' => true], $data));
    exit;
}

function ensure_data_dir(): void {
    if (!is_dir(DATA_DIR)) {
        @mkdir(DATA_DIR, 0755, true);
    }
}

function device_file(string $device): string {
    $safe = preg_replace('/[^A-Za-z0-9_\-]/', '_', $device);
    if (strlen($safe) < 3 || strlen($safe) > 64) {
        $safe = 'unknown';
    }
    return DATA_DIR . $safe . '.json';
}

function load_device(string $device): array {
    $f = device_file($device);
    if (!file_exists($f)) {
        return ['device' => $device, 'items' => []];
    }
    $raw = file_get_contents($f);
    $data = json_decode($raw, true);
    return is_array($data) ? $data : ['device' => $device, 'items' => []];
}

function save_device(array $data): void {
    ensure_data_dir();
    $f = device_file($data['device']);
    file_put_contents($f, json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), LOCK_EX);
    @chmod($f, 0664);
}

$action = $_REQUEST['action'] ?? '';

switch ($action) {
    case 'submit':
        $device = trim($_POST['device'] ?? '');
        $msg = trim($_POST['msg'] ?? '');
        if ($device === '' || $msg === '') {
            fail('device 和 msg 不能为空');
        }
        if (mb_strlen($msg) > 5000) {
            fail('反馈内容过长（最多 5000 字符）');
        }
        $data = load_device($device);
        $item = [
            'id' => uniqid('fb_'),
            'msg' => $msg,
            'time' => now_ms(),
            'contact' => trim($_POST['contact'] ?? ''),
            'version' => trim($_POST['version'] ?? ''),
            'replies' => [],
        ];
        array_unshift($data['items'], $item);
        save_device($data);
        ok(['item' => $item]);
        break;

    case 'list':
        $device = trim($_GET['device'] ?? '');
        if ($device === '') {
            fail('device 不能为空');
        }
        $since = (int)($_GET['since'] ?? 0);
        $data = load_device($device);
        // 返回该设备所有反馈，及是否有新回复（回复时间 > since）
        $items = $data['items'];
        $newReplyCount = 0;
        foreach ($items as $it) {
            if (isset($it['replies']) && is_array($it['replies'])) {
                foreach ($it['replies'] as $r) {
                    if (($r['time'] ?? 0) > $since) {
                        $newReplyCount++;
                    }
                }
            }
        }
        ok(['items' => $items, 'newReplyCount' => $newReplyCount, 'serverTime' => now_ms()]);
        break;

    case 'admin_list':
        if (!is_admin()) {
            fail('未授权', 403);
        }
        ensure_data_dir();
        $all = [];
        foreach (glob(DATA_DIR . '*.json') as $f) {
            $raw = file_get_contents($f);
            $d = json_decode($raw, true);
            if (is_array($d)) {
                $all[] = $d;
            }
        }
        // 按最新反馈时间排序
        usort($all, function ($a, $b) {
            $ta = $a['items'][0]['time'] ?? 0;
            $tb = $b['items'][0]['time'] ?? 0;
            return $tb - $ta;
        });
        ok(['devices' => $all]);
        break;

    case 'admin_count':
        if (!is_admin()) {
            fail('未授权', 403);
        }
        ensure_data_dir();
        $unread = 0;
        foreach (glob(DATA_DIR . '*.json') as $f) {
            $raw = file_get_contents($f);
            $d = json_decode($raw, true);
            if (is_array($d)) {
                foreach ($d['items'] ?? [] as $it) {
                    if (empty($it['replies'])) {
                        $unread++;
                    }
                }
            }
        }
        ok(['unread' => $unread]);
        break;

    case 'reply':
        $device = trim($_POST['device'] ?? '');
        $msg_id = trim($_POST['msg_id'] ?? '');
        $content = trim($_POST['content'] ?? '');
        if (!is_admin()) {
            fail('未授权', 403);
        }
        if ($device === '' || $msg_id === '' || $content === '') {
            fail('device、msg_id、content 不能为空');
        }
        $data = load_device($device);
        $found = false;
        foreach ($data['items'] as &$it) {
            if ($it['id'] === $msg_id) {
                $it['replies'][] = [
                    'content' => $content,
                    'time' => now_ms(),
                ];
                $found = true;
                break;
            }
        }
        unset($it);
        if (!$found) {
            // 注意：不能用 404 —— 本站 nginx 配了 error_page 404 /404.html，
            // 会把 JSON 响应体替换成 HTML 404 页，前端 res.json() 直接抛错（显示"网络错误"）。
            // 400 不会被 error_page 拦截，JSON 能正常回传。
            fail('未找到该反馈', 400);
        }
        save_device($data);
        ok(['ok' => true]);
        break;

    default:
        fail('未知 action');
}
