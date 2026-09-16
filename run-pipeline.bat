@echo off
REM ===================================================================
REM run-pipeline.bat - Windows Runner for k6 & Allure Performance Suite
REM ===================================================================

SET CONFIG=%1
IF "%CONFIG%"=="" SET CONFIG=config.json

echo Starting performance pipeline with config: %CONFIG%
node run-pipeline.js --config "%CONFIG%"
