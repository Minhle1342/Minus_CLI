import React, { useState, useMemo, useRef } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { SLASH_COMMANDS } from '../../cli-ui.js';
import { Workspace } from '../../../workspace/workspace.js';
import { FileMentionEngine } from '../../../workspace/file-attachment.js';
import {
  LineEditorState,
  insertText,
  deleteBackward,
  deleteForward,
  deleteWordBackward,
  deleteToStart,
  deleteToEnd,
  moveCursor,
} from './input-line-editor.js';

export interface InputPromptBarProps {
  onSubmit: (value: string) => void;
  onToggleCompact?: () => void;
  onAbort?: () => void;
  disabled?: boolean;
  workspacePath?: string;
  workspace?: Workspace;
  initialHistory?: string[];
  maxHistory?: number;
}

interface SuggestionItem {
  label: string;
  desc?: string;
  valueToInsert: string;
  type: 'command' | 'file' | 'directory';
  mentionStart?: number;
  mentionEnd?: number;
}

export const InputPromptBar: React.FC<InputPromptBarProps> = ({
  onSubmit,
  onToggleCompact,
  onAbort,
  disabled = false,
  workspacePath,
  workspace: externalWorkspace,
  initialHistory = [],
  maxHistory = 100,
}) => {
  const { columns } = useWindowSize();
  const [value, setValue] = useState('');
  const [cursorOffset, setCursorOffset] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isDismissed, setIsDismissed] = useState(false);

  // Command History
  const [history, setHistory] = useState<string[]>(initialHistory);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [tempValue, setTempValue] = useState<string>('');
  const lastPasteTimestamp = useRef<number>(0);
  const graphemes = useMemo(
    () => Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)),
    [value],
  );

  // Khởi tạo hoặc tái sử dụng Workspace instance để quét gợi ý file
  const activeWorkspace = useMemo(() => {
    if (externalWorkspace) return externalWorkspace;
    try {
      return new Workspace(workspacePath || process.cwd());
    } catch {
      return undefined;
    }
  }, [externalWorkspace, workspacePath]);

  // Tính toán danh sách gợi ý Slash Commands hoặc File Mentions theo thời gian thực (đồng bộ vị trí con trỏ)
  const { suggestions, suggestionType } = useMemo<{
    suggestions: SuggestionItem[];
    suggestionType: 'command' | 'file' | 'none';
  }>(() => {
    // 1. Gợi ý File Mentions (@...) dựa trên con trỏ thực tế
    if (activeWorkspace) {
      const activeMention = FileMentionEngine.extractActiveMention(value, cursorOffset);
      if (activeMention) {
        const fileSuggestions = FileMentionEngine.getFileSuggestions(
          value,
          activeWorkspace,
          cursorOffset,
          5
        );

        if (fileSuggestions.length > 0) {
          return {
            suggestionType: 'file',
            suggestions: fileSuggestions.map((s) => ({
              label: s.displayPath,
              desc: s.type === 'directory' ? 'Thư mục' : (s.sizeBytes ? `${Math.round(s.sizeBytes / 1024)} KB` : 'Tệp tin'),
              valueToInsert: s.displayPath,
              type: s.type,
              mentionStart: s.mentionStart,
              mentionEnd: s.mentionEnd,
            })),
          };
        }
      }
    }

    // 2. Gợi ý Slash Commands (/...) tính đến vị trí con trỏ
    const textBeforeCursor = value.slice(0, cursorOffset);
    const trimmedBefore = textBeforeCursor.trimStart();
    if (trimmedBefore.startsWith('/') && !trimmedBefore.includes(' ')) {
      const query = trimmedBefore.toLowerCase();
      const matched = SLASH_COMMANDS.filter((cmd) => {
        if (cmd.command.toLowerCase().startsWith(query)) return true;
        return cmd.aliases?.some((alias) => alias.toLowerCase().startsWith(query));
      }).slice(0, 5);

      if (matched.length > 0) {
        return {
          suggestionType: 'command',
          suggestions: matched.map((cmd) => ({
            label: cmd.command,
            desc: cmd.description,
            valueToInsert: cmd.command,
            type: 'command',
          })),
        };
      }
    }

    return { suggestions: [], suggestionType: 'none' };
  }, [value, cursorOffset, activeWorkspace]);

  // Áp dụng lựa chọn gợi ý vào thanh nhập liệu chính xác tại vị trí mention/command
  const applySelectedSuggestion = (item: SuggestionItem) => {
    if (item.type === 'command') {
      const textBeforeCursor = value.slice(0, cursorOffset);
      const slashMatch = textBeforeCursor.match(/(?:^|\s)(\/[^\s]*)$/);
      if (slashMatch && slashMatch[1] !== undefined) {
        const slashStart = textBeforeCursor.length - slashMatch[1].length;
        const before = value.slice(0, slashStart);
        const after = value.slice(cursorOffset);
        const formattedInsert = item.valueToInsert + ' ';
        const newValue = `${before}${formattedInsert}${after.trimStart()}`;
        setValue(newValue);
        setCursorOffset(before.length + formattedInsert.length);
      } else {
        const textAfterCursor = value.slice(cursorOffset);
        const newValue = item.valueToInsert + ' ' + textAfterCursor.trimStart();
        setValue(newValue);
        setCursorOffset(item.valueToInsert.length + 1);
      }
    } else {
      const formattedInsert = item.valueToInsert.includes(' ')
        ? `"${item.valueToInsert}"`
        : item.valueToInsert;
      // Nếu là thư mục, không thêm khoảng trắng để người dùng gõ tiếp đường dẫn con
      const trailingSuffix = item.type === 'directory' ? '' : ' ';
      const inserted = `@${formattedInsert}${trailingSuffix}`;

      if (item.mentionStart !== undefined && item.mentionEnd !== undefined) {
        const before = value.slice(0, item.mentionStart);
        const after = value.slice(item.mentionEnd);
        const newValue = `${before}${inserted}${after}`;
        setValue(newValue);
        setCursorOffset(before.length + inserted.length);
      } else {
        const before = value.slice(0, cursorOffset);
        const after = value.slice(cursorOffset);
        const newValue = `${before}${inserted}${after}`;
        setValue(newValue);
        setCursorOffset(before.length + inserted.length);
      }
    }
    setSelectedIndex(0);
    setIsDismissed(false);
  };

  useInput((input, key) => {
    if (disabled) {
      // Khi đang chạy tác vụ, hỗ trợ hủy qua Esc hoặc Ctrl+C
      if (key.escape || (key.ctrl && input === 'c')) {
        onAbort?.();
      }
      return;
    }

    // Phát hiện sự kiện dán văn bản (Paste chunk):
    // 1. Chứa ký tự xuống dòng (\r, \n) hoặc mã Bracketed Paste (\x1b[200~)
    // 2. Hoặc chuỗi text dài hơn 1 ký tự và không phải phím điều hướng/phím tắt chức năng
    const isPasteChunk =
      Boolean(input) &&
      (input.includes('\r') ||
        input.includes('\n') ||
        input.includes('\x1b[200~') ||
        (input.length > 1 &&
          !key.ctrl &&
          !key.meta &&
          !key.leftArrow &&
          !key.rightArrow &&
          !key.upArrow &&
          !key.downArrow &&
          !key.home &&
          !key.end &&
          !key.pageDown &&
          !key.pageUp &&
          !key.tab));

    if (isPasteChunk) {
      lastPasteTimestamp.current = Date.now();
      const next = insertText({ value, cursorOffset }, input);
      setValue(next.value);
      setCursorOffset(next.cursorOffset);
      setHistoryIndex(-1);
      setIsDismissed(false);
      setSelectedIndex(0);
      return;
    }

    // Phím tắt Ctrl+O: Thu gọn/mở rộng reasoning
    if (key.ctrl && input === 'o') {
      onToggleCompact?.();
      return;
    }

    // Phím tắt Ctrl+C: Xóa trắng dòng hoặc hủy
    if (key.ctrl && input === 'c') {
      if (value.length > 0) {
        setValue('');
        setCursorOffset(0);
        setHistoryIndex(-1);
        setTempValue('');
        setIsDismissed(false);
        setSelectedIndex(0);
      } else {
        onAbort?.();
      }
      return;
    }

    const hasActiveSuggestions = suggestions.length > 0 && !isDismissed;

    // Phím Escape: Tạm thời đóng danh sách gợi ý nếu đang mở, hoặc xóa trắng dòng nếu không có gợi ý
    if (key.escape) {
      if (hasActiveSuggestions) {
        setIsDismissed(true);
      } else if (value.length > 0) {
        setValue('');
        setCursorOffset(0);
        setHistoryIndex(-1);
        setTempValue('');
      } else {
        onAbort?.();
      }
      return;
    }

    // Phím Mũi tên Xuống (Down Arrow)
    if (key.downArrow) {
      if (hasActiveSuggestions) {
        setSelectedIndex((prev) => (prev + 1) % suggestions.length);
      } else if (historyIndex !== -1) {
        // Duyệt History về phía gần nhất
        if (historyIndex < history.length - 1) {
          const nextIndex = historyIndex + 1;
          setHistoryIndex(nextIndex);
          const hist = history[nextIndex];
          setValue(hist);
          setCursorOffset(hist.length);
        } else {
          // Quay lại draft ban đầu trước khi duyệt history
          setHistoryIndex(-1);
          setValue(tempValue);
          setCursorOffset(tempValue.length);
        }
      }
      return;
    }

    // Phím Mũi tên Lên (Up Arrow)
    if (key.upArrow) {
      if (hasActiveSuggestions) {
        setSelectedIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length);
      } else if (history.length > 0) {
        // Duyệt History về phía cũ hơn
        if (historyIndex === -1) {
          setTempValue(value);
          const nextIndex = history.length - 1;
          setHistoryIndex(nextIndex);
          const hist = history[nextIndex];
          setValue(hist);
          setCursorOffset(hist.length);
        } else if (historyIndex > 0) {
          const nextIndex = historyIndex - 1;
          setHistoryIndex(nextIndex);
          const hist = history[nextIndex];
          setValue(hist);
          setCursorOffset(hist.length);
        }
      }
      return;
    }

    // Phím Tab: Điền gợi ý đang chọn
    if (key.tab && hasActiveSuggestions) {
      const activeIdx = Math.min(Math.max(0, selectedIndex), suggestions.length - 1);
      const selected = suggestions[activeIdx];
      if (selected) {
        applySelectedSuggestion(selected);
      }
      return;
    }

    // Phím Return / Enter
    if (key.return) {
      // Chống tự động submit do ký tự \r\n đi kèm chuỗi dán (paste debounce guard)
      if (Date.now() - lastPasteTimestamp.current < 80) {
        return;
      }

      if (hasActiveSuggestions) {
        const activeIdx = Math.min(Math.max(0, selectedIndex), suggestions.length - 1);
        const selected = suggestions[activeIdx];
        if (selected) {
          applySelectedSuggestion(selected);
          return;
        }
      }

      // Nộp prompt bình thường
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        setHistory((prev) => {
          if (prev.length > 0 && prev[prev.length - 1] === trimmed) return prev;
          const updated = [...prev, trimmed];
          return updated.length > maxHistory ? updated.slice(updated.length - maxHistory) : updated;
        });
        setHistoryIndex(-1);
        setTempValue('');
        setValue('');
        setCursorOffset(0);
        setSelectedIndex(0);
        setIsDismissed(false);
        onSubmit(trimmed);
      }
      return;
    }

    // 1. Home / Ctrl+A: Về đầu dòng
    if (key.home || (key.ctrl && input === 'a')) {
      setCursorOffset(0);
      setIsDismissed(false);
      return;
    }

    // 2. End / Ctrl+E: Về cuối dòng
    if (key.end || (key.ctrl && input === 'e')) {
      setCursorOffset(value.length);
      setIsDismissed(false);
      return;
    }

    // 3. Ctrl+U: Xóa từ con trỏ về đầu dòng
    if (key.ctrl && input === 'u') {
      const next = deleteToStart({ value, cursorOffset });
      setValue(next.value);
      setCursorOffset(next.cursorOffset);
      setHistoryIndex(-1);
      setIsDismissed(false);
      setSelectedIndex(0);
      return;
    }

    // 4. Ctrl+K: Xóa từ con trỏ tới cuối dòng
    if (key.ctrl && input === 'k') {
      const next = deleteToEnd({ value, cursorOffset });
      setValue(next.value);
      setCursorOffset(next.cursorOffset);
      setHistoryIndex(-1);
      setIsDismissed(false);
      setSelectedIndex(0);
      return;
    }

    // 5. Ctrl+W: Xóa từ phía trước
    if (key.ctrl && input === 'w') {
      const next = deleteWordBackward({ value, cursorOffset });
      setValue(next.value);
      setCursorOffset(next.cursorOffset);
      setHistoryIndex(-1);
      setIsDismissed(false);
      setSelectedIndex(0);
      return;
    }

    // 6. Left Arrow: Sang trái (Ctrl+Left / Alt+Left nhảy theo từ)
    if (key.leftArrow) {
      const mode = (key.ctrl || key.meta) ? 'wordLeft' : 'left';
      const next = moveCursor({ value, cursorOffset }, mode);
      setCursorOffset(next.cursorOffset);
      setIsDismissed(false);
      return;
    }

    // 7. Right Arrow: Sang phải (Ctrl+Right / Alt+Right nhảy theo từ)
    if (key.rightArrow) {
      const mode = (key.ctrl || key.meta) ? 'wordRight' : 'right';
      const next = moveCursor({ value, cursorOffset }, mode);
      setCursorOffset(next.cursorOffset);
      setIsDismissed(false);
      return;
    }

    // 8. Delete: Xóa ký tự phía sau con trỏ
    if (key.delete) {
      const next = deleteForward({ value, cursorOffset });
      setValue(next.value);
      setCursorOffset(next.cursorOffset);
      setHistoryIndex(-1);
      setIsDismissed(false);
      setSelectedIndex(0);
      return;
    }

    // 9. Backspace: Xóa ký tự phía trước con trỏ
    if (key.backspace) {
      const next = deleteBackward({ value, cursorOffset });
      setValue(next.value);
      setCursorOffset(next.cursorOffset);
      setHistoryIndex(-1);
      setIsDismissed(false);
      setSelectedIndex(0);
      return;
    }

    // 10. Các ký tự thông thường hoặc đoạn văn bản dán (paste)
    if (!key.ctrl && !key.meta && input) {
      const next = insertText({ value, cursorOffset }, input);
      setValue(next.value);
      setCursorOffset(next.cursorOffset);
      setHistoryIndex(-1);
      setIsDismissed(false);
      setSelectedIndex(0);
    }
  });

  const showSuggestions = suggestions.length > 0 && !isDismissed;
  const safeSelectedIndex = suggestions.length > 0
    ? Math.min(Math.max(0, selectedIndex), suggestions.length - 1)
    : 0;
  // ponytail: grapheme count can overflow on wide glyphs; use terminal-cell width measurement if that matters.
  const visibleCount = Math.max(1, columns - 5);
  const cursorGraphemeIndex = graphemes.findIndex(({ index }) => index >= cursorOffset);
  const viewportStart = Math.min(
    Math.max(0, graphemes.length - visibleCount),
    Math.max(0, (cursorGraphemeIndex < 0 ? graphemes.length : cursorGraphemeIndex) - visibleCount + 1),
  );
  const visibleGraphemes = graphemes.slice(viewportStart, viewportStart + visibleCount);
  const visibleBeforeCursor = visibleGraphemes.filter(({ index }) => index < cursorOffset).map(({ segment }) => segment).join('');
  const cursorGrapheme = visibleGraphemes.find(({ index }) => index === cursorOffset)?.segment;
  const visibleAfterCursor = visibleGraphemes
    .filter(({ index }) => index > cursorOffset)
    .map(({ segment }) => segment)
    .join('');

  return (
    <Box flexDirection="column" paddingX={1} marginY={0}>
      {/* Khung Gợi Ý Interactive với Phím Điều Hướng */}
      {showSuggestions && (
        <Box flexDirection="column" borderStyle="single" borderColor="red" paddingX={1} marginY={0}>
          <Box justifyContent="space-between">
            <Text color="red" bold>
              {suggestionType === 'command'
                ? '⚡ GỢI Ý SLASH COMMANDS'
                : '📁 GỢI Ý FILE / THƯ MỤC (@MENTION)'}
            </Text>
            <Text color="gray" dimColor>
              ↑/↓: Chọn · Tab/Enter: Điền · Esc: Đóng
            </Text>
          </Box>
          <Box flexDirection="column" marginTop={0}>
            {suggestions.map((item, index) => {
              const isSelected = index === safeSelectedIndex;
              const badge = item.type === 'directory' ? '[DIR]' : item.type === 'file' ? '[FILE]' : '[CMD]';

              return (
                <Box key={`${item.label}-${index}`} gap={1}>
                  <Text color={isSelected ? 'red' : 'gray'} bold>
                    {isSelected ? '❯' : ' '}
                  </Text>
                  <Text color={isSelected ? 'red' : 'white'} bold>
                    {badge}
                  </Text>
                  <Text
                    color="white"
                    bold={isSelected}
                    underline={isSelected}
                  >
                    {item.label}
                  </Text>
                  {item.desc && (
                    <Text color="gray" dimColor>
                      ─ {item.desc}
                    </Text>
                  )}
                </Box>
              );
            })}
          </Box>
        </Box>
      )}

      {/* Dòng nhập lệnh chính với cursor rendering chân thực */}
      {disabled ? (
        <Box gap={1} width={Math.max(1, columns - 2)} backgroundColor="gray" marginTop={0}>
          <Text color="red" bold>❯</Text>
          <Text color="gray" dimColor>[Đang thực thi nhiệm vụ... Nhấn Esc hoặc Ctrl+C để hủy yêu cầu]</Text>
        </Box>
      ) : (
        <Box gap={1} width={Math.max(1, columns - 2)} backgroundColor="gray" marginTop={0}>
          <Text color="red" bold>❯</Text>
          {value.length === 0 ? (
            <Text color="red">█</Text>
          ) : !cursorGrapheme ? (
            <Box>
              <Text color="white">{visibleGraphemes.map(({ segment }) => segment).join('')}</Text>
              <Text color="red">█</Text>
            </Box>
          ) : (
            <Box>
              <Text color="white">{visibleBeforeCursor}</Text>
              <Text backgroundColor="white" color="black">
                {cursorGrapheme}
              </Text>
              <Text color="white">{visibleAfterCursor}</Text>
            </Box>
          )}
        </Box>
      )}
      {!disabled && value.length === 0 && (
        <Text color="gray" dimColor>Enter gửi · ↑/↓ lịch sử · Ctrl+O reasoning · Esc xóa/hủy</Text>
      )}
    </Box>
  );
};
