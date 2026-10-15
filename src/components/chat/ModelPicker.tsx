import React, { useState, useMemo } from 'react';
import { X, Search, Check, Cpu, Layers } from 'lucide-react';
import type { ModelCatalog, ModelGroup } from '../../types';

interface ModelPickerProps {
  isOpen: boolean;
  onClose: () => void;
  catalog: ModelCatalog | null;
  loading?: boolean;
  currentModel?: { provider?: string; model?: string } | null;
  onSelectModel: (provider: string, model: string) => Promise<boolean | void> | void;
}

export const ModelPicker: React.FC<ModelPickerProps> = ({
  isOpen,
  onClose,
  catalog,
  loading = false,
  currentModel,
  onSelectModel,
}) => {
  const [search, setSearch] = useState('');
  const [activeGroup, setActiveGroup] = useState<string>('all');
  const [submitting, setSubmitting] = useState<string | null>(null);

  const groups = catalog?.groups || [];

  // 过滤后的模型项
  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    return groups
      .filter((g) => activeGroup === 'all' || g.id === activeGroup)
      .map((g) => ({
        ...g,
        models: g.models.filter(
          (m) => !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
        ),
      }))
      .filter((g) => g.models.length > 0);
  }, [groups, activeGroup, search]);

  if (!isOpen) return null;

  const handleSelect = async (provider: string, modelId: string) => {
    setSubmitting(modelId);
    try {
      await onSelectModel(provider, modelId);
      onClose();
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40 backdrop-blur-xs animate-in fade-in duration-200">
      {/* 遮罩点击关闭 */}
      <div className="flex-1" onClick={onClose} />

      {/* 底部浮层面板 */}
      <div className="bg-white border-t border-gray-200 rounded-t-3xl max-h-[85vh] flex flex-col shadow-2xl animate-in slide-in-from-bottom duration-250">
        {/* 顶部把手与标题 */}
        <div className="px-5 pt-3 pb-3 border-b border-gray-100 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-[#f4f4f6] flex items-center justify-center text-blue-600">
              <Cpu size={16} />
            </div>
            <div>
              <h3 className="text-[15px] font-bold text-[#18181b] tracking-tight">切换模型 (Select Model)</h3>
              <p className="text-[11px] text-[#52525b]">
                当前：{currentModel?.model || catalog?.default?.model || '未设定'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 rounded-full bg-[#f4f4f6] hover:bg-gray-200 flex items-center justify-center text-gray-600 hover:text-black transition-colors cursor-pointer min-h-[44px]"
          >
            <X size={16} />
          </button>
        </div>

        {/* 搜索栏 */}
        <div className="p-3 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-[#f4f4f6] border border-gray-200/80 focus-within:border-black focus-within:bg-white transition-all">
            <Search size={14} className="text-[#52525b] shrink-0" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索模型名称，例如：MiniMax、DeepSeek-V3、Claude..."
              className="flex-1 bg-transparent text-[13px] text-[#18181b] placeholder-gray-400 focus:outline-none"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="text-[#52525b] hover:text-black min-h-[44px] flex items-center"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        {/* 提供商分组标签 (横向滚动) */}
        {groups.length > 1 && (
          <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-1.5 overflow-x-auto no-scrollbar shrink-0">
            <button
              type="button"
              onClick={() => setActiveGroup('all')}
              className={`px-3 py-1.5 rounded-full text-[12px] font-medium whitespace-nowrap transition-colors cursor-pointer min-h-[44px] ${
                activeGroup === 'all'
                  ? 'bg-black text-white shadow-xs'
                  : 'bg-[#f4f4f6] text-gray-600 hover:text-black'
              }`}
            >
              全部 ({groups.reduce((acc, g) => acc + g.models.length, 0)})
            </button>
            {groups.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => setActiveGroup(g.id)}
                className={`px-3 py-1.5 rounded-full text-[12px] font-medium whitespace-nowrap transition-colors cursor-pointer min-h-[44px] ${
                  activeGroup === g.id
                    ? 'bg-black text-white shadow-xs'
                    : 'bg-[#f4f4f6] text-gray-600 hover:text-black'
                }`}
              >
                {g.name} ({g.models.length})
              </button>
            ))}
          </div>
        )}

        {/* 模型列表 */}
        <div className="flex-1 overflow-y-auto p-4 pb-[calc(1.5rem+var(--sab))] space-y-4">
          {loading && (
            <div className="flex flex-col items-center justify-center py-12 text-[#52525b] space-y-2">
              <div className="w-6 h-6 border-2 border-black border-t-transparent rounded-full animate-spin" />
              <p className="text-[13px]">正在获取模型目录...</p>
            </div>
          )}

          {!loading && filteredGroups.length === 0 && (
            <div className="text-center py-12 text-[#52525b]">
              <Layers size={32} className="mx-auto mb-2 opacity-40" />
              <p className="text-[13px]">未找到匹配的模型</p>
            </div>
          )}

          {!loading &&
            filteredGroups.map((group) => (
              <div key={group.id} className="space-y-1.5">
                <div className="text-[11px] font-bold text-[#52525b] tracking-wider uppercase px-1">
                  {group.name}
                </div>
                <div className="grid grid-cols-1 gap-1.5">
                  {group.models.map((model) => {
                    const isSelected =
                      currentModel?.model === model.id ||
                      (!currentModel?.model && catalog?.default?.model === model.id);
                    const isBusy = submitting === model.id;

                    return (
                      <button
                        key={model.id}
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleSelect(group.id, model.id)}
                        className={`w-full min-h-[44px] px-4 py-2.5 rounded-2xl text-left flex items-center justify-between gap-3 transition-all cursor-pointer border ${
                          isSelected
                            ? 'bg-black text-white border-black shadow-xs'
                            : 'bg-[#f4f4f6] border-gray-200/60 text-[#18181b] hover:border-gray-400'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[13px] font-semibold truncate font-mono">
                              {model.name || model.id}
                            </span>
                            {model.reasoning && (
                              <span className={`px-1.5 py-0.2 rounded text-[10px] font-sans ${
                                isSelected
                                  ? 'bg-white/20 text-white'
                                  : 'bg-purple-50 text-purple-700 border border-purple-200'
                              }`}>
                                深度思考
                              </span>
                            )}
                          </div>
                          <div className={`text-[11px] truncate mt-0.5 ${
                            isSelected ? 'text-[#52525b]' : 'text-[#52525b]'
                          }`}>
                            {group.name} · {model.id}
                          </div>
                        </div>

                        {isSelected && (
                          <div className="w-5 h-5 rounded-full bg-white text-black flex items-center justify-center shrink-0">
                            <Check size={12} strokeWidth={3} />
                          </div>
                        )}
                        {isBusy && (
                          <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
};
