Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = fso.BuildPath(base, "start.cmd")
command = Chr(34) & shell.ExpandEnvironmentStrings("%ComSpec%") & Chr(34) & " /d /c " & Chr(34) & Chr(34) & scriptPath & Chr(34) & Chr(34)
If WScript.Arguments.Count > 0 Then
  If WScript.Arguments(0) = "--validate-only" Then WScript.Quit 0
End If
shell.Run command, 0, False
