# ============================================================================
# CnkeIDE 安装程序 · 快捷方式修复脚本
# ============================================================================
#
# 由 build/installer.nsh 的 CnkeVerifyShortcut 宏释放到 %TEMP% 并执行。
#
# 【存在意义 —— 中文安装路径问题】
# NSIS 原生 CreateShortCut 走 ANSI 代码页，当安装目录含中文时
# （实测 D:\新建文件夹\CnkeIDE），写出的 .lnk 的 TargetPath 会把中文丢成
# D:\CNKEIDE\CnkeIDE.exe —— 是个死链，用户点击无法启动。
# PowerShell 的 WScript.Shell COM 走 Unicode，能正确处理中文路径。
#
# 【为什么用独立文件而不是在 NSIS 里 FileWrite 拼出来】
# NSIS 的 FileWrite 按逗号切分参数，而本脚本里逗号很多
# （ReadAllText 的编码参数、IconLocation 的 "路径,索引" 等），
# 一旦出现逗号 NSIS 就报 "FileWrite expects 2 parameters, got 3"，
# 且 NSIS 没有可用的字面量逗号写法。故改为预置文件、安装时释放。
#
# 【输入 / 输出契约】（由 installer.nsh 写入，均为 UTF-16LE 无 BOM）
#   读 cnke_sc_expected.txt → 期望的 exe 完整路径
#   读 cnke_sc_lnkpath.txt  → 快捷方式 .lnk 的完整路径
#   写 cnke_sc_actual.txt   → 最终 .lnk 的 TargetPath（UTF-16LE 无 BOM）
#
# 【退出码】0 = 已正确（创建或修复成功）；1 = 仍与期望不符
#
# 【BOM 注意】结果文件必须写成「无 BOM」的 UTF-16LE。
# NSIS 的 FileWriteUTF16LE 不带 BOM，且 FileReadUTF16LE 不会剥离 BOM；
# 若这里用 [Text.Encoding]::Unicode（会加 U+FEFF），NSIS 读回的值前面会多一个
# U+FEFF，导致 "$5" == "$INSTDIR\..." 恒为假 → 误报「快捷方式创建失败」。
# 因此下面显式用 UnicodeEncoding($false, $false) 关闭 BOM。
# ============================================================================

$ErrorActionPreference = 'Stop'

$tempDir  = $env:TEMP
$expFile  = Join-Path $tempDir 'cnke_sc_expected.txt'
$lnkFile  = Join-Path $tempDir 'cnke_sc_lnkpath.txt'
$actFile  = Join-Path $tempDir 'cnke_sc_actual.txt'

# 读 UTF-16LE（NSIS FileWriteUTF16LE 的产物无 BOM）
$encRead = New-Object System.Text.UnicodeEncoding($false, $false)

function Read-Utf16Le([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return '' }
    $bytes = [System.IO.File]::ReadAllBytes($path)
    return $encRead.GetString($bytes).Trim([char]0, [char]0xFEFF, ' ', "`r", "`n", "`t")
}

$desired = Read-Utf16Le $expFile
$lnkPath = Read-Utf16Le $lnkFile

if ([string]::IsNullOrWhiteSpace($desired) -or [string]::IsNullOrWhiteSpace($lnkPath)) {
    [System.IO.File]::WriteAllText($actFile, '', $encRead)
    exit 1
}

$ws = New-Object -ComObject WScript.Shell

function Get-LnkTarget([string]$path) {
    try {
        if (-not (Test-Path -LiteralPath $path)) { return '' }
        return $ws.CreateShortcut($path).TargetPath
    } catch {
        return ''
    }
}

$current = Get-LnkTarget $lnkPath

if ($current -ne $desired) {
    # 删除旧链接（可能是 ANSI 写入的死链），用 Unicode API 重建
    if (Test-Path -LiteralPath $lnkPath) {
        Remove-Item -LiteralPath $lnkPath -Force -ErrorAction SilentlyContinue
    }

    # 目标目录必须存在
    $lnkDir = Split-Path -Parent $lnkPath
    if ($lnkDir -and -not (Test-Path -LiteralPath $lnkDir)) {
        New-Item -ItemType Directory -Path $lnkDir -Force | Out-Null
    }

    $exeDir  = Split-Path -Parent $desired
    $lnk     = $ws.CreateShortcut($lnkPath)
    $lnk.TargetPath       = $desired
    $lnk.WorkingDirectory = $exeDir
    # IconLocation 形如 "C:\path\app.exe,0"
    $lnk.IconLocation     = ('{0},0' -f $desired)
    $lnk.Description      = 'CnkeIDE'
    $lnk.Save()
}

$final = Get-LnkTarget $lnkPath

# 结果写回给 NSIS（无 BOM UTF-16LE，与 FileReadUTF16LE 语义对齐）
[System.IO.File]::WriteAllText($actFile, $final, $encRead)

if ($final -eq $desired) { exit 0 } else { exit 1 }
