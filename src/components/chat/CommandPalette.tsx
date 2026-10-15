import React from 'react';
import { Terminal, Sparkles, BookOpen, Trash2, Cpu, CheckSquare } from 'lucide-react';

export interface CommandItem {
  command: string;
  label: string;
  description: string;
  icon?: React.ReactNode;
}

const COMMON_COMMANDS: CommandItem[] = [
  {
    command: '/plan',
    label: '开启计划模式',
    description: '进入先计划再执行模式，列出详尽步骤清单',
    icon: <CheckSquare size={14} className="text-[#38bdf8]" />,
  },
  {
    command: '/plan off',
    label: '退出计划模式',
    description: '切回直接执行模式',
    icon: <CheckSquare size={14} className="text-[#64748b]" />,
  },
  {
    command: '/compact',
    label: '压缩上下文',
    description: '总结并收纳历史上下文，降低 Token 占用',
    icon: <Sparkles size={14} className="text-[#f59e0b]" />,
  },
  {
    command: '/git status',
    label: 'Git 状态',
    description: '检查当前工作区分支状态与修改文件',
    icon: <Terminal size={14} className="text-[#38bdf8]" />,
  },
  {
    command: '/test',
    label: '运行测试',
    description: '执行项目自动化测试套件',
    icon: <Terminal size={14} className="text-[#10b981]" />,
  },
  {
    command: '/stats',
    label: '会话统计',
    description: '查看当前会话运行步数、速度与缓存消耗',
    icon: <Cpu size={14} className="text-[#a855f7]" />,
  },
  {
    command: '/help',
    label: '指令帮助',
    description: '列出遥控端与宿主支持的完整工具与指令说明',
    icon: <BookOpen size={14} className="text-[#10b981]" />,
  },
  {
    command: '/clear',
    label: '清屏',
    description: '清空当前屏幕已渲染内容（不影响电脑端记录）',
    icon: <Trash2 size={14} className="text-[#f43f5e]" />,
  },
];

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (command: string) => void;
  filterText?: string;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  onSelect,
  filterText = '',
}) => {
  if (!isOpen) return null;

  const q = filterText.startsWith('/') ? filterText.slice(1).toLowerCase() : filterText.toLowerCase();
  const filtered = COMMON_COMMANDS.filter(
    (c) => !q || c.command.toLowerCase().includes(q) || c.label.toLowerCase().includes(q)
  );

  return (
    <div className="absolute bottom-full mb-2 inset-x-2 z-40 bg-[#0d121f] border border-white/10 rounded-2xl shadow-2xl p-2 animate-in fade-in slide-in-from-bottom-2 duration-150 backdrop-blur-md">
      <div className="px-2.5 py-1.5 flex items-center justify-between text-[11px] font-bold text-[#64748b] border-b border-white/5">
        <span className="flex items-center gap-1.5 text-[#38bdf8]">
          <Terminal size={12} />
          <span>快捷斜杠指令 (Commands)</span>
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-[#64748b] hover:text-white cursor-pointer px-1"
        >
          关闭
        </button>
      </div>

      <div className="max-h-56 overflow-y-auto mt-1 space-y-1">
        {filtered.map((item) => (
          <button
            key={item.command}
            type="button"
            onClick={() => {
              onSelect(item.command);
              onClose();
            }}
            className="w-full px-3 py-2 rounded-xl text-left flex items-center gap-2.5 hover:bg-white/[0.06] transition-colors cursor-pointer group studio-tap"
          >
            <div className="w-6 h-6 rounded-lg bg-white/5 flex items-center justify-center shrink-0">
              {item.icon}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[12.5px] font-bold text-white group-hover:text-[#38bdf8] transition-colors">
                  {item.command}
                </span>
                <span className="text-[11.5px] text-[#cbd5e1]">{item.label}</span>
              </div>
              <p className="text-[10.5px] text-[#64748b] truncate">{item.description}</p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};
