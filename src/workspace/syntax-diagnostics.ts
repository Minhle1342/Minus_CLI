import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Workspace } from './workspace.js';
import { getOrCreateTypeScriptService } from '../tools/inspect-symbol.js';
import type { DiagnosticItem } from '../tools/typescript-service.js';

const execAsync = promisify(exec);

// Standard Python built-ins that are always defined in global scope
const PYTHON_BUILTINS = new Set([
  'abs', 'all', 'any', 'ascii', 'bin', 'bool', 'breakpoint', 'bytearray', 'bytes',
  'callable', 'chr', 'classmethod', 'compile', 'complex', 'delattr', 'dict', 'dir',
  'divmod', 'enumerate', 'eval', 'exec', 'filter', 'float', 'format', 'frozenset',
  'getattr', 'globals', 'hasattr', 'hash', 'help', 'hex', 'id', 'input', 'int',
  'isinstance', 'issubclass', 'iter', 'len', 'list', 'locals', 'map', 'max',
  'memoryview', 'min', 'next', 'object', 'oct', 'open', 'ord', 'pow', 'print',
  'property', 'range', 'repr', 'reversed', 'round', 'set', 'setattr', 'slice',
  'sorted', 'staticmethod', 'str', 'sum', 'super', 'tuple', 'type', 'vars', 'zip',
  '__import__', 'None', 'True', 'False', 'Ellipsis', 'NotImplemented',
  'Exception', 'BaseException', 'ValueError', 'TypeError', 'KeyError', 'IndexError',
  'AttributeError', 'ImportError', 'ModuleNotFoundError', 'FileNotFoundError',
  'IOError', 'OSError', 'RuntimeError', 'StopIteration', 'KeyboardInterrupt',
  'self', 'cls', 'args', 'kwargs', '__name__', '__file__', '__doc__', '__all__',
]);

// Common Framework classes that frequently cause NameErrors when missing imports
const COMMON_FRAMEWORK_IMPORTS: Record<string, string> = {
  // FastAPI / Starlette / Pydantic
  'RedirectResponse': 'from fastapi.responses import RedirectResponse (or starlette.responses)',
  'JSONResponse': 'from fastapi.responses import JSONResponse (or starlette.responses)',
  'HTMLResponse': 'from fastapi.responses import HTMLResponse (or starlette.responses)',
  'StreamingResponse': 'from fastapi.responses import StreamingResponse (or starlette.responses)',
  'FileResponse': 'from fastapi.responses import FileResponse (or starlette.responses)',
  'PlainTextResponse': 'from fastapi.responses import PlainTextResponse (or starlette.responses)',
  'Response': 'from fastapi import Response',
  'Request': 'from fastapi import Request',
  'HTTPException': 'from fastapi import HTTPException',
  'FastAPI': 'from fastapi import FastAPI',
  'APIRouter': 'from fastapi import APIRouter',
  'Depends': 'from fastapi import Depends',
  'Query': 'from fastapi import Query',
  'Path': 'from fastapi import Path (or from pathlib import Path)',
  'Body': 'from fastapi import Body',
  'Header': 'from fastapi import Header',
  'Cookie': 'from fastapi import Cookie',
  'Form': 'from fastapi import Form',
  'File': 'from fastapi import File',
  'UploadFile': 'from fastapi import UploadFile',
  'Security': 'from fastapi import Security',
  'BackgroundTasks': 'from fastapi import BackgroundTasks',
  'BaseModel': 'from pydantic import BaseModel',
  'Field': 'from pydantic import Field',
  'validator': 'from pydantic import validator',
  'field_validator': 'from pydantic import field_validator',
  'model_validator': 'from pydantic import model_validator',
  'EmailStr': 'from pydantic import EmailStr',
  'CORSMiddleware': 'from fastapi.middleware.cors import CORSMiddleware',
  // Flask / Django
  'jsonify': 'from flask import jsonify',
  'render_template': 'from flask import render_template',
  'redirect': 'from flask import redirect (or from django.shortcuts import redirect)',
  'url_for': 'from flask import url_for',
  'abort': 'from flask import abort',
  'render': 'from django.shortcuts import render',
  'get_object_or_404': 'from django.shortcuts import get_object_or_404',
  'HttpResponse': 'from django.http import HttpResponse',
  'JsonResponse': 'from django.http import JsonResponse',
  // Standard Libraries
  'asyncio': 'import asyncio',
  'datetime': 'import datetime (or from datetime import datetime)',
  'timedelta': 'from datetime import timedelta',
  'timezone': 'from datetime import timezone',
  'json': 'import json',
  're': 'import re',
  'os': 'import os',
  'sys': 'import sys',
  'typing': 'import typing',
  'Optional': 'from typing import Optional',
  'Union': 'from typing import Union',
  'List': 'from typing import List',
  'Dict': 'from typing import Dict',
  'Set': 'from typing import Set',
  'Tuple': 'from typing import Tuple',
  'Any': 'from typing import Any',
  'Callable': 'from typing import Callable',
  'Coroutine': 'from typing import Coroutine',
  'Literal': 'from typing import Literal',
  'Annotated': 'from typing import Annotated',
  // SQLAlchemy
  'Column': 'from sqlalchemy import Column',
  'Integer': 'from sqlalchemy import Integer',
  'String': 'from sqlalchemy import String',
  'Boolean': 'from sqlalchemy import Boolean',
  'DateTime': 'from sqlalchemy import DateTime',
  'ForeignKey': 'from sqlalchemy import ForeignKey',
  'relationship': 'from sqlalchemy.orm import relationship',
  'sessionmaker': 'from sqlalchemy.orm import sessionmaker',
  'declarative_base': 'from sqlalchemy.orm import declarative_base',
  'select': 'from sqlalchemy import select',
};

/**
 * CodeSyntaxValidator
 * 
 * Độc lập thẩm định lỗi cú pháp (SyntaxError), biến chưa khai báo (Undefined Name / NameError / F821),
 * và các lỗi compiler/LSP trên toàn bộ các ngôn ngữ (TypeScript, JavaScript, Python, JSON).
 */
export class CodeSyntaxValidator {
  /**
   * Thẩm định 1 file duy nhất và trả về danh sách lỗi nếu có
   */
  static async validateFile(filePath: string, workspace: Workspace): Promise<DiagnosticItem[]> {
    const ext = path.extname(filePath).toLowerCase();
    let safePath: string;
    try {
      safePath = workspace.resolveSafePath(filePath);
    } catch {
      return [];
    }

    try {
      if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
        return this.validateTypeScript(filePath, workspace);
      }

      if (ext === '.py') {
        return await this.validatePython(filePath, safePath);
      }

      if (ext === '.json') {
        return await this.validateJSON(filePath, safePath);
      }
    } catch {
      // Ignore unparseable or inaccessible file errors
    }

    return [];
  }

  /**
   * Thẩm định danh sách nhiều file
   */
  static async validateFiles(filePaths: string[], workspace: Workspace): Promise<DiagnosticItem[]> {
    const uniqueFiles = Array.from(new Set(filePaths.filter(Boolean)));
    const allDiagnostics: DiagnosticItem[] = [];

    for (const file of uniqueFiles) {
      const diags = await this.validateFile(file, workspace);
      allDiagnostics.push(...diags);
    }

    return allDiagnostics;
  }

  /**
   * Thẩm định TypeScript / JavaScript Language Service
   */
  private static validateTypeScript(filePath: string, workspace: Workspace): DiagnosticItem[] {
    try {
      const tsService = getOrCreateTypeScriptService(workspace);
      const diags = tsService.getDiagnostics(filePath);
      return diags.filter((d) => d.category === 'error');
    } catch {
      return [];
    }
  }

  /**
   * Thẩm định cú pháp và NameError / Missing Import trong Python
   */
  private static async validatePython(filePath: string, safePath: string): Promise<DiagnosticItem[]> {
    const diagnostics: DiagnosticItem[] = [];
    let content: string;
    try {
      content = await fs.readFile(safePath, 'utf8');
    } catch {
      return [];
    }

    // 1. Kiểm tra biên dịch / AST bằng Python CLI nếu có sẵn trên máy
    try {
      const checkScript = `
import ast, sys
try:
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        source = f.read()
    ast.parse(source, filename=sys.argv[1])
    print('SYNTAX_OK')
except SyntaxError as e:
    print(f'SYNTAX_ERROR:{e.lineno}:{e.offset or 0}:{e.msg}')
except Exception as e:
    print(f'PARSER_ERROR:1:0:{str(e)}')
`;
      const escapedScript = checkScript.replace(/\r?\n/g, ' ').replace(/"/g, '\\"');
      const { stdout } = await execAsync(`python -c "${escapedScript}" "${safePath}"`, { timeout: 2000 });
      const trimmed = stdout.trim();

      if (trimmed.startsWith('SYNTAX_ERROR:')) {
        const parts = trimmed.split(':');
        const line = parseInt(parts[1] || '1', 10);
        const col = parseInt(parts[2] || '0', 10);
        const msg = parts.slice(3).join(':').trim() || 'Python SyntaxError';
        diagnostics.push({
          code: 9001,
          category: 'error',
          file: filePath,
          line,
          character: col,
          message: `[Python SyntaxError]: ${msg} at line ${line}`,
        });
      }
    } catch {
      // Fallback: nếu máy không cài Python trong PATH, tiếp tục với static scope analyzer bên dưới
    }

    // 2. Static AST Scope & Missing Import Analyzer
    const staticNameErrors = this.analyzePythonScopeAndImports(filePath, content);
    diagnostics.push(...staticNameErrors);

    return diagnostics;
  }

  /**
   * Phân tích tĩnh phạm vi biến và nhận diện các Class / Function bị thiếu import
   */
  private static analyzePythonScopeAndImports(filePath: string, content: string): DiagnosticItem[] {
    const diagnostics: DiagnosticItem[] = [];
    const definedSymbols = new Set<string>(PYTHON_BUILTINS);
    const lines = content.split('\n');

    // Quét Pass 1: Thu thập toàn bộ các import và định nghĩa trong file
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // `import foo` hoặc `import foo as bar`
      const importMatch = trimmed.match(/^import\s+([a-zA-Z0-9_.,\s]+)/);
      if (importMatch && importMatch[1]) {
        for (const part of importMatch[1].split(',')) {
          const item = part.trim();
          if (item.includes(' as ')) {
            const alias = item.split(' as ')[1]?.trim();
            if (alias) definedSymbols.add(alias);
          } else {
            const rootMod = item.split('.')[0]?.trim();
            if (rootMod) definedSymbols.add(rootMod);
          }
        }
      }

      // `from foo import bar, baz as qux`
      const fromImportMatch = trimmed.match(/^from\s+[a-zA-Z0-9_.]+\s+import\s+([a-zA-Z0-9_*,\s()]+)/);
      if (fromImportMatch && fromImportMatch[1]) {
        if (fromImportMatch[1].includes('*')) {
          // Wildcard import -> coi như import hết mọi thứ
          return diagnostics;
        }
        const cleaned = fromImportMatch[1].replace(/[()]/g, '');
        for (const part of cleaned.split(',')) {
          const item = part.trim();
          if (!item) continue;
          if (item.includes(' as ')) {
            const alias = item.split(' as ')[1]?.trim();
            if (alias) definedSymbols.add(alias);
          } else {
            definedSymbols.add(item);
          }
        }
      }

      // `def func_name(...)` hoặc `async def func_name(...)`
      const defMatch = trimmed.match(/^(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/);
      if (defMatch && defMatch[1]) {
        definedSymbols.add(defMatch[1]);
        if (defMatch[2]) {
          for (const param of defMatch[2].split(',')) {
            const pName = param.split(':')[0]?.split('=')[0]?.trim().replace(/^\*/, '');
            if (pName) definedSymbols.add(pName);
          }
        }
      }

      // `class ClassName(...)`
      const classMatch = trimmed.match(/^class\s+([a-zA-Z0-9_]+)/);
      if (classMatch && classMatch[1]) {
        definedSymbols.add(classMatch[1]);
      }

      // `variable = ...`
      const assignMatch = trimmed.match(/^([a-zA-Z0-9_,\s]+)\s*[:=]/);
      if (assignMatch && assignMatch[1] && !trimmed.startsWith('return') && !trimmed.startsWith('if')) {
        for (const v of assignMatch[1].split(',')) {
          const vName = v.trim().split(':')[0]?.trim();
          if (vName && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(vName)) {
            definedSymbols.add(vName);
          }
        }
      }

      // `for item in ...`
      const forMatch = trimmed.match(/^for\s+([a-zA-Z0-9_,\s]+)\s+in\s+/);
      if (forMatch && forMatch[1]) {
        for (const item of forMatch[1].split(',')) {
          const vName = item.trim();
          if (vName) definedSymbols.add(vName);
        }
      }

      // `with ... as target`
      const withMatch = trimmed.match(/\bas\s+([a-zA-Z0-9_,\s]+):?$/);
      if (withMatch && withMatch[1]) {
        for (const item of withMatch[1].split(',')) {
          const vName = item.trim();
          if (vName) definedSymbols.add(vName);
        }
      }

      // `except Exception as e`
      const exceptMatch = trimmed.match(/^except\s+.*?\bas\s+([a-zA-Z0-9_]+):/);
      if (exceptMatch && exceptMatch[1]) {
        definedSymbols.add(exceptMatch[1]);
      }
    }

    // Quét Pass 2: Phát hiện các identifier framework được gọi nhưng chưa import
    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i] || '';
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
        continue;
      }

      // Tìm tất cả các từ dạng Identifier (PascalCase hoặc UpperCamelCase như RedirectResponse, BaseModel)
      const matches = trimmed.matchAll(/\b([A-Z][a-zA-Z0-9_]+)\b/g);
      for (const match of matches) {
        const identifier = match[1];
        if (!identifier) continue;

        // Nếu là một framework identifier đã biết mà CHƯA ĐƯỢC IMPORT HOẶC KHAI BÁO
        if (COMMON_FRAMEWORK_IMPORTS[identifier] && !definedSymbols.has(identifier)) {
          const suggestion = COMMON_FRAMEWORK_IMPORTS[identifier];
          diagnostics.push({
            code: 821, // F821 in Flake8/Ruff
            category: 'error',
            file: filePath,
            line: lineNum,
            character: match.index || 0,
            message: `[Python F821 NameError]: '${identifier}' is used at line ${lineNum} but is not defined or imported. Missing import: add '${suggestion}' at the top of ${filePath}.`,
          });
        }
      }
    }

    return diagnostics;
  }

  /**
   * Thẩm định file JSON hợp lệ
   */
  private static async validateJSON(filePath: string, safePath: string): Promise<DiagnosticItem[]> {
    try {
      const content = await fs.readFile(safePath, 'utf8');
      JSON.parse(content);
      return [];
    } catch (err: any) {
      return [{
        code: 9002,
        category: 'error',
        file: filePath,
        line: 1,
        character: 0,
        message: `[JSON SyntaxError]: Invalid JSON format in ${filePath}: ${err.message}`,
      }];
    }
  }
}
