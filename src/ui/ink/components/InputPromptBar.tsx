import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { SLASH_COMMANDS } from '../../cli-ui.js';
import { Workspace } from '../../../workspace/workspace.js';
import { FileMentionEngine } from '../../../workspace/file-attachment.js';

export interface InputPromptBarProps {
  onSubmit: (value: string) => void;
  onToggleCompact?: () => void;
  disabled?: boolean;
  workspacePath?: string;
  workspace?: Workspace;
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
  disabled = false,
  workspacePath,
  workspace: externalWorkspace,
}) => {
  const [value, setValue] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isDismissed, setIsDismissed] = useState(false);
  const [hasNavigated, setHasNavigated] = useState(false);

  // Khởi tạo hoặc tái sử dụng Workspace instance để quét gợi ý file
  const activeWorkspace = useMemo(() => {
    if (externalWorkspace) return externalWorkspace;
    try {
      return new Workspace(workspacePath || process.cwd());
    } catch {
      return undefined;
    }
  }, [externalWorkspace, workspacePath]);

  // Tính toán danh sách gợi ý Slash Commands hoặc File Mentions
  const { suggestions, suggestionType } = useMemo<{
    suggestions: SuggestionItem[];
    suggestionType: 'command' | 'file' | 'none';
  }>(() => {
    const trimmed = value.trimStart();

    // 1. Gợi ý File Mentions (@...)
    if (value.includes('@') && activeWorkspace) {
      const activeMention = FileMentionEngine.extractActiveMention(value);
      if (activeMention) {
        const fileSuggestions = FileMentionEngine.getFileSuggestions(
          value,
          activeWorkspace,
          value.length,
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

    // 2. Gợi ý Slash Commands (/...)
    if (trimmed.startsWith('/') && !trimmed.includes(' ')) {
      const query = trimmed.toLowerCase();
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
  }, [value, activeWorkspace]);

  // Áp dụng lựa chọn gợi ý vào thanh nhập liệu
  const applySelectedSuggestion = (item: SuggestionItem) => {
    if (item.type === 'command') {
      setValue(item.valueToInsert + ' ');
    } else if (item.mentionStart !== undefined && item.mentionEnd !== undefined) {
      const before = value.slice(0, item.mentionStart);
      const after = value.slice(item.mentionEnd);
      setValue(`${before}@${item.valueToInsert} ${after}`);
    } else {
      setValue((prev) => `${prev} @${item.valueToInsert} `);
    }
    setSelectedIndex(0);
    setHasNavigated(false);
  };

  useInput((input, key) => {
    if (disabled) return;

    // Phím tắt Ctrl+O: Thu gọn/mở rộng reasoning
    if (key.ctrl && input === 'o') {
      onToggleCompact?.();
      return;
    }

    // Phím Escape: Tạm thời đóng danh sách gợi ý
    if (key.escape) {
      setIsDismissed(true);
      setHasNavigated(false);
      return;
    }

    const hasActiveSuggestions = suggestions.length > 0 && !isDismissed;

    // Phím điều hướng Mũi tên Xuống (Down Arrow): Di chuyển xuống item kế tiếp
    if (key.downArrow && hasActiveSuggestions) {
      setSelectedIndex((prev) => (prev + 1) % suggestions.length);
      setHasNavigated(true);
      return;
    }

    // Phím điều hướng Mũi tên Lên (Up Arrow): Di chuyển lên item trước
    if (key.upArrow && hasActiveSuggestions) {
      setSelectedIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length);
      setHasNavigated(true);
      return;
    }

    // Phím Tab: Điền gợi ý đang chọn
    if (key.tab && hasActiveSuggestions) {
      const selected = suggestions[selectedIndex] || suggestions[0];
      if (selected) {
        applySelectedSuggestion(selected);
      }
      return;
    }

    // Phím Return / Enter
    if (key.return) {
      // Nếu người dùng đang điều hướng danh sách gợi ý bằng mũi tên, Enter sẽ áp dụng lựa chọn
      if (hasActiveSuggestions && hasNavigated) {
        const selected = suggestions[selectedIndex];
        if (selected) {
          applySelectedSuggestion(selected);
          return;
        }
      }

      // Ngược lại, thực thi nộp prompt bình thường
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        setValue('');
        setSelectedIndex(0);
        setHasNavigated(false);
        setIsDismissed(false);
        onSubmit(trimmed);
      }
      return;
    }

    // Phím Backspace / Delete
    if (key.backspace || key.delete) {
      setValue((prev) => prev.slice(0, -1));
      setIsDismissed(false);
      setSelectedIndex(0);
      setHasNavigated(false);
      return;
    }

    // Các ký tự thông thường
    if (!key.ctrl && !key.meta && input) {
      setValue((prev) => prev + input);
      setIsDismissed(false);
      setSelectedIndex(0);
      setHasNavigated(false);
    }
  });

  const showSuggestions = suggestions.length > 0 && !isDismissed;

  return (
    <Box flexDirection="column" paddingX={1} marginY={0}>
      {/* Khung Gợi Ý Interactive với Phím Điều Hướng */}
      {showSuggestions && (
        <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1} marginY={0}>
          <Box justifyContent="space-between">
            <Text color="cyan" bold>
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
              const isSelected = index === selectedIndex;
              const badge = item.type === 'directory' ? '[DIR]' : item.type === 'file' ? '[FILE]' : '[CMD]';
              const badgeColor = item.type === 'directory' ? 'blue' : item.type === 'file' ? 'magenta' : 'yellow';

              return (
                <Box key={`${item.label}-${index}`} gap={1}>
                  <Text color={isSelected ? 'cyan' : 'gray'} bold>
                    {isSelected ? '❯' : ' '}
                  </Text>
                  <Text color={badgeColor} bold>
                    {badge}
                  </Text>
                  <Text
                    color={isSelected ? 'cyan' : 'white'}
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

      {/* Dòng nhập lệnh chính */}
      <Box gap={1} marginTop={0}>
        <Text color="cyan" bold>❯</Text>
        <Text color="white">{value}</Text>
        <Text color="cyan">█</Text>
      </Box>
    </Box>
  );
};
