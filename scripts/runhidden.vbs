' runhidden.vbs - run a command line in a fully hidden window (no console)
' Usage: wscript runhidden.vbs "<full command line>"
' Note: the command line is passed as ONE quoted argument from the .bat file;
' doubled quotes ("") inside it are literal quotes per Windows arg parsing rules.
Option Explicit
Dim cmd, i
If WScript.Arguments.Count >= 1 Then
    cmd = WScript.Arguments(0)
    For i = 1 To WScript.Arguments.Count - 1
        cmd = cmd & " " & WScript.Arguments(i)
    Next
    CreateObject("WScript.Shell").Run cmd, 0, False
End If
