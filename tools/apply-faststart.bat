@echo off
rem Rewrite every pool clip whose index table (moov) sits at the end of the file,
rem keeping the original under assets/videos/originals/.
rem
rem The plugin only reports the problem (the "not optimised" badge in its settings
rem card); it never rewrites your media on its own. This is the one step.
title dsh-boot-animation: optimise clips
cd /d "%~dp0.."
node tools\apply-faststart.mjs --apply
echo.
pause
