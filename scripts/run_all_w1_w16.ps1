# 一次性跑完 W1~W27 全部测试脚本。
# 注意：$ErrorActionPreference 必须是 Continue —— 原生命令（tsx）被 2>&1 重定向时，
# stderr 会变成 ErrorRecord，Stop 策略下会直接抛 NativeCommandError 中断整个套件，
# CI 上只能看到一个无明细的 exit code 1（曾经踩过）。这里改为收集失败、最后统一 exit 1。
$ErrorActionPreference = 'Continue'
$tests = @(
  'test_w1_llm_resilience',
  'test_w2_parallel_tools',
  'test_w3_plan',
  'test_w3_plan_integration',
  'test_w4_tools',
  'test_w5_semantic',
  'test_w6_routing',
  'test_w7_approval',
  'test_w8_compression_subagent',
  'test_w9_production',
  'test_w10_rag',
  'test_w11_context_tracker',
  'test_w12_browser_image',
  'test_w13_updater_fix',
  'test_w14_pptx',
  'test_w14_version_fix',
  'test_w14_workspace',
  'test_w15_safe_spawn',
  'test_w16_markdown_spec',
  'test_w16_render_check',
  'test_w17_inline_completion',
  'test_w18_history_stats',
  'test_w19_task_workspace',
  'test_w20_report_export',
  'test_w21_task_manage',
  'test_w22_content_search',
  'test_w24_project_instructions',
  'test_w25_permission',
  'test_w26_git_ops',
  'test_w27_autofix'
)

$tsx = Join-Path $PSScriptRoot '..\node_modules\.bin\tsx.cmd'
if (-not (Test-Path $tsx)) { throw 'Missing local tsx. Run npm install first.' }

$totalPass = 0
$totalFail = 0
$failedTests = @()

foreach ($test in $tests) {
  $file = Join-Path $PSScriptRoot "$test.mjs"
  if (-not (Test-Path $file)) { throw "Missing test script: $file" }

  Write-Host ""
  Write-Host "----- $test -----"
  $output = & $tsx $file 2>&1
  $exitCode = $LASTEXITCODE
  $output | ForEach-Object { Write-Host $_ }

  $line = $output | Where-Object { $_.ToString() -match '\d+\s+(?:passed|PASS),\s*\d+\s+(?:failed|FAIL)' } | Select-Object -Last 1
  if ($line -and $line.ToString() -match '(\d+)\s+(?:passed|PASS),\s*(\d+)\s+(?:failed|FAIL)') {
    $totalPass += [int]$Matches[1]
    $totalFail += [int]$Matches[2]
  }

  if ($exitCode -ne 0) {
    $failedTests += $test
    # 用 GitHub annotation 输出失败摘要：API 能直接读到，不必翻完整日志
    $detail = ($output |
      ForEach-Object { $_.ToString().Trim() } |
      Where-Object { $_ -match 'FAIL|failed|Error|error:|Cannot|undefined|not found' } |
      Select-Object -Last 6) -join ' || '
    if ($detail.Length -gt 800) { $detail = $detail.Substring(0, 800) }
    if (-not $detail) { $detail = "exit code $exitCode" }
    Write-Host "::error title=$test::$detail"
  }
}

Write-Host ""
Write-Host "===== Total: $totalPass passed, $totalFail failed ====="
if ($failedTests.Count -gt 0) {
  Write-Host "Failed scripts: $($failedTests -join ', ')"
  exit 1
}
