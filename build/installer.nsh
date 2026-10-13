; ============================================================================
; CnkeIDE 安装脚本扩展（NSIS）
; ============================================================================
;
; 【编码要求】本文件必须保存为 UTF-8 with BOM。
; electron-builder 以 UTF8 模式编译主脚本，被 include 的文件也必须带 BOM，
; 否则报 "Bad text encoding"。切勿改成 ANSI/GBK 或无 BOM 的 UTF-8。
;
; 【实现约束】NSIS 宏中不要用 $DIR 这类自定义宏参数直接拼路径，
; 编译器会把 "$DIR\..." 误解析为变量；统一改用运行时变量传参。
;
; ----------------------------------------------------------------------------
; 【快捷方式 · 中文路径根因与修复史】
;
; 现象（1.2.14 实机复现）：
;   安装目录含中文时（如 D:\新建文件夹\CnkeIDE），
;   - 桌面快捷方式完全不存在
;   - 开始菜单快捷方式存在，但 TargetPath = D:\CNKEIDE\CnkeIDE.exe（中文被吞）
;     → 是死链，点击无法启动
;   结果：比「不创建快捷方式」更糟 —— 用户以为装好了，点了却报错。
;
; 根因（两层）：
;   1) NSIS 原生 CreateShortCut 走 ANSI 代码页，中文安装路径被转成 ????/
;      丢弃，写出错误 TargetPath。官方 addDesktopLink 宏同样有此问题。
;   2) 1.2.15 尝试用 PowerShell 兜底修复，但 nsExec::ExecToStack 的「命令行」
;      本身也是 ANSI 编码的 —— 中文 $INSTDIR 在传给 PowerShell 之前就已被破坏，
;      所以 PowerShell 拿到的"期望路径"已经是错的，修完仍是死链。
;
; 修复策略（1.2.16）：中文路径绝不经过命令行传递。
;   - 期望路径 → 用 FileWriteUTF16LE 写文件（NSIS Unicode 原生写盘）
;   - 快捷方式目标目录 → 同样走 UTF-16 文件
;   - 只把「纯 ASCII 的 .ps1 脚本路径」放进命令行
;   - PowerShell 从文件读回真实中文路径，用 Unicode API 创建 .lnk
;   全程命令行只有 ASCII，中文仅通过 UTF-16 文件流转，彻底绕开代码页问题。
;
; 【安全边界】任何快捷方式失败都只提示、绝不中断安装（MessageBox + DetailPrint）。
; ============================================================================

!macro CnkeEnsureShortcut TARGET_VAR DISPLAY_NAME LABEL_ID

  ; 目标 exe 必须存在，否则不创建（避免生成死链）
  ${IfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    DetailPrint "[快捷方式] 跳过（${DISPLAY_NAME}）：主程序不存在 $INSTDIR\${APP_EXECUTABLE_FILENAME}"
    Goto cnke_sc_next_${LABEL_ID}
  ${EndIf}

  ; ---- 创建 / 校验 / 自愈：统一交给 PowerShell ----
  ;
  ; 【为何不用 NSIS 原生 CreateShortCut】
  ; 该 API 走 ANSI 代码页，中文安装路径下必然写出死链（见文件头说明）。
  ; 现改为由 PowerShell（Unicode API）直接创建并校验，不再生成中间死链。
  !insertmacro CnkeVerifyShortcut "${TARGET_VAR}" "${DISPLAY_NAME}" "${LABEL_ID}"

  cnke_sc_next_${LABEL_ID}:

!macroend

; 校验 .lnk 的 TargetPath 是否指向真实安装路径；不一致则用 PowerShell 重建。
;
; 输入：TARGET_VAR —— NSIS 运行时变量名（$DESKTOP / $SMPROGRAMS），
;       在调用前必须已由 SetShellVarContext 设定好上下文。
!macro CnkeVerifyShortcut TARGET_VAR DISPLAY_NAME LABEL_ID

  ; ---- ① 把「期望的 exe 路径」写入 UTF-16LE 文件（Unicode 写盘，不经命令行）----
  ClearErrors
  FileOpen $3 "$TEMP\cnke_sc_expected.txt" w
  ${If} ${Errors}
    DetailPrint "[快捷方式] 无法写入期望路径文件（${DISPLAY_NAME}），跳过"
    Goto cnke_sc_verify_done_${LABEL_ID}
  ${EndIf}
  FileWriteUTF16LE $3 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  FileClose $3

  ; ---- ② 把「快捷方式的完整目标路径」也写入 UTF-16 文件 ----
  ; 【关键】这里必须用运行时变量展开得到真实路径，例如
  ;   $DESKTOP → C:\Users\xxx\Desktop
  ; 若把 "$DESKTOP" 这个名字直接写进 PowerShell 字符串，它会变成字面量
  ; '$DESKTOP\CnkeIDE.lnk'（单引号不展开），导致修复写到错误位置。
  StrCpy $6 "${TARGET_VAR}\${SHORTCUT_NAME}.lnk"
  ClearErrors
  FileOpen $3 "$TEMP\cnke_sc_lnkpath.txt" w
  ${If} ${Errors}
    DetailPrint "[快捷方式] 无法写入目标路径文件（${DISPLAY_NAME}），跳过"
    Goto cnke_sc_verify_done_${LABEL_ID}
  ${EndIf}
  FileWriteUTF16LE $3 "$6"
  FileClose $3

  ; ---- ③ 生成 PowerShell 修复脚本（内容纯 ASCII，路径全部从文件读）----
  !insertmacro CnkeWriteFixScript

  ; ---- ④ 执行：校验 + 必要时重建，脚本自身完成全部逻辑 ----
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$TEMP\cnke_sc_fix.ps1"'
  Pop $0      ; 退出码（0=已正确，1=修复失败，其它=异常）
  Pop $1      ; 脚本 stdout（仅用于日志）

  ; ---- ⑤ 从结果文件读回真实 TargetPath 做最终判定 ----
  StrCpy $5 ""
  ClearErrors
  FileOpen $3 "$TEMP\cnke_sc_actual.txt" r
  ${IfNot} ${Errors}
    FileReadUTF16LE $3 $5
    FileClose $3
  ${EndIf}

  ${If} "$5" == "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    DetailPrint "[快捷方式] 创建并校验通过（${DISPLAY_NAME}）→ $5"
  ${Else}
    ; 仍失败：提示手动创建，但绝不中断安装
    DetailPrint "[快捷方式] 自动创建失败（${DISPLAY_NAME}），实际指向 [$5]"
    MessageBox MB_ICONEXCLAMATION "无法自动创建${DISPLAY_NAME}快捷方式。$\r$\n$\r$\n请手动创建以方便下次启动：$\r$\n1. 打开安装目录：$INSTDIR$\r$\n2. 右键 ${APP_EXECUTABLE_FILENAME} → 发送到 → 桌面快捷方式$\r$\n$\r$\n（现在也可以直接从上述目录双击启动）"
  ${EndIf}

  cnke_sc_verify_done_${LABEL_ID}:

  ; 清理临时文件（避免残留）
  Delete "$TEMP\cnke_sc_expected.txt"
  Delete "$TEMP\cnke_sc_lnkpath.txt"
  Delete "$TEMP\cnke_sc_fix.ps1"
  Delete "$TEMP\cnke_sc_actual.txt"

!macroend

; 写出 PowerShell 修复脚本到 $TEMP\cnke_sc_fix.ps1。
;
; 【重要】脚本内容必须全部是 ASCII：
;   - 中文路径从 UTF-16 文件读取（cnke_sc_expected.txt / cnke_sc_lnkpath.txt）
;   - 脚本路径本身在 $TEMP 下，保证是 ASCII
; 这样命令行与脚本文件都不含中文，彻底规避代码页问题。
;
; NSIS 中 "$$" 转义为字面量 "$"，因此 $$env:TEMP 在生成的文件里就是 $env:TEMP。
;
; 【实现方式】不再用 FileWrite 逐行拼 PowerShell 脚本。
; 原因：NSIS 的 FileWrite 按「逗号」切分参数，而 PowerShell 代码里逗号极常见
; （ReadAllText($f, $enc)、UnicodeEncoding($false,$false)、IconLocation "p,0"），
; 一旦出现逗号就报 "FileWrite expects 2 parameters, got 3"；
; 而 NSIS 没有可用的字面量逗号写法（StrCpy $x "," 同样被切分）。
; 因此改为把一个**预先写好的 .ps1 作为安装包内资源**（build/nsis-shortcut-fix.ps1），
; 安装时直接释放到 $TEMP，彻底避开转义与代码页问题。
!macro CnkeWriteFixScript

  ClearErrors
  SetOutPath "$TEMP"
  File /oname=cnke_sc_fix.ps1 "${BUILD_RESOURCES_DIR}\nsis-shortcut-fix.ps1"
  ${If} ${Errors}
    DetailPrint "[快捷方式] 无法释放修复脚本，跳过 PowerShell 兜底"
  ${EndIf}

!macroend

; 升级前先终止旧版主进程及其子进程，避免 NSIS 卸载旧应用文件时被占用。
; taskkill 未找到进程时返回非零属于正常情况，故不将其作为安装失败处理。
!macro customInit
  nsExec::ExecToStack '"$SYSDIR\cmd.exe" /C taskkill /F /T /IM CnkeIDE.exe >nul 2>&1'
  Pop $0
  Pop $1
  nsExec::ExecToStack '"$SYSDIR\cmd.exe" /C taskkill /F /T /IM cnke-claw.exe >nul 2>&1'
  Pop $0
  Pop $1
  Sleep 800
!macroend

!macro customInstall
  DetailPrint "正在清理旧版本残留..."

  ; 【重要】切勿删除 $LOCALAPPDATA\cnke-claw-updater 目录！
  ; 该目录是 electron-updater 的差分更新缓存（updaterCacheDirName=cnke-claw-updater），
  ; electron-builder 的 installApplicationFiles 会在本宏执行前，把当前安装包复制到
  ; 该目录下的 installer.exe 作为下次差分更新的拼装基准。
  ; 1.2.2 时代曾在此 RMDir /r 该目录，导致每次更新都丢失基准 → 退化为全量 ~86MB。
  ; 故此处只清理真正的 Squirrel 旧残留（cnke-claw 时代的目录，与差分基准无关）。

  ; 清理 Squirrel 旧残留目录（1.2.1 及更早 productName=cnke-claw 时代遗留）
  SetShellVarContext current
  StrCpy $0 "$LOCALAPPDATA\cnke-claw"
  ${If} ${FileExists} "$0\*.*"
    RMDir /r "$0"
    DetailPrint "已清理旧 Squirrel 目录: $0"
  ${EndIf}

  ; 清理 cnkeide-updater\pending 目录（electron-updater 下载残留，避免旧包干扰）
  StrCpy $0 "$LOCALAPPDATA\cnkeide-updater\pending"
  ${If} ${FileExists} "$0\*.*"
    RMDir /r "$0"
    DetailPrint "已清理 updater pending 目录: $0"
  ${EndIf}

  ; ============================================================
  ; 【核心】强制重建快捷方式
  ;
  ; 为什么必须放在这里：官方 addDesktopLink 宏在 isUpdated=true（升级）时
  ; 会跳过创建桌面快捷方式，导致每次升级后桌面图标都不重新生成。
  ; customInstall 在文件安装完成后执行，是唯一可靠的兜底位置。
  ; 此处同时覆盖「当前用户桌面」与「开始菜单」，并做 TargetPath 校验自愈。
  ; ============================================================
  DetailPrint "正在校验并重建快捷方式..."

  SetShellVarContext current
  !insertmacro CnkeEnsureShortcut "$DESKTOP" "桌面" desktop
  !insertmacro CnkeEnsureShortcut "$SMPROGRAMS" "开始菜单" startmenu

  ; 刷新资源管理器图标缓存，装完立刻可见桌面图标
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'

  ; 差分基准安装包若在位则保留（保障下次更新仍走增量下载）
  StrCpy $0 "$LOCALAPPDATA\cnke-claw-updater"
  ${If} ${FileExists} "$0\installer.exe"
    DetailPrint "差分基准安装包在位，保留: $0"
  ${EndIf}

  DetailPrint "安装准备完成"
!macroend

!macro customUnInstall
  DetailPrint "正在清理 CnkeIDE 残留..."

  ; 清理 updater 目录
  SetShellVarContext current
  StrCpy $0 "$LOCALAPPDATA\cnkeide-updater"
  ${If} ${FileExists} "$0\*.*"
    RMDir /r "$0"
  ${EndIf}

  ; 不删 cnke-claw-updater（可能是别的产品用），保持保守

  ; 清理用户数据（可选，默认保留）
  ; StrCpy $0 "$APPDATA\cnke-claw"
  ; ${If} ${FileExists} "$0\*.*"
  ;   RMDir /r "$0"
  ; ${EndIf}
!macroend
