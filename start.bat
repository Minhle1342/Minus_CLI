@echo off
node --max-old-space-size=4096 --import tsx src/index.ts %*
