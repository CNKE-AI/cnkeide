; CnkeIDE NSIS 自定义安装脚本
; 1.2.2 新增：清理旧的 cnke-claw-updater 目录（双 productName 冲突根除）

!macro customInstall
  DetailPrint "正在清理旧版本残留..."

  ; 清理旧的 cnke-claw-updater 目录（如果存在）
  ; 之前版本 productName=cnke-claw 时创建的 Squirrel updater 目录
  ; 留着会导致 electron-updater 状态机混乱（双 updater 目录）
  SetShellVarContext current
  StrCpy $0 "$LOCALAPPDATA\cnke-claw-updater"
  ${If} ${FileExists} "$0\*.*"
    RMDir /r "$0"
    DetailPrint "已清理旧 updater 目录: $0"
  ${EndIf}

  ; 清理 pending 目录（如果用户在更新中途关机/取消，会残留下载）
  StrCpy $0 "$LOCALAPPDATA\cnkeide-updater\pending"
  ${If} ${FileExists} "$0\*.*"
    RMDir /r "$0"
    DetailPrint "已清理旧 pending 目录"
  ${EndIf}

  DetailPrint "安装准备完成"
!macroend

; 卸载时同样清理（避免重装时残留）
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
