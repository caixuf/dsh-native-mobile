import React, { useRef } from 'react';
import { Paperclip, Image, X, AtSign } from 'lucide-react';

export interface ImageAttachment {
  data: string; // base64 string
  mediaType: string;
  name: string;
}

interface AttachmentBarProps {
  attachment: ImageAttachment | null;
  onRemove: () => void;
  onAttach: (attachment: ImageAttachment) => void;
  onInsertPath?: (path: string) => void;
  workspace?: string | null;
}

export const AttachmentBar: React.FC<AttachmentBarProps> = ({
  attachment,
  onRemove,
  onAttach,
  onInsertPath,
  workspace,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert('目前仅支持发送图片附件');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // 提取 base64 部分
      const base64Data = result.split(',')[1] || result;
      onAttach({
        data: base64Data,
        mediaType: file.type || 'image/png',
        name: file.name,
      });
    };
    reader.readAsDataURL(file);
    // 重置 input 以允许再次选择同名文件
    e.target.value = '';
  };

  const handlePromptPath = () => {
    const defaultVal = workspace ? `${workspace}/` : '';
    const path = window.prompt('输入要在对话中引用的电脑文件路径：', defaultVal);
    if (path && path.trim() && onInsertPath) {
      onInsertPath(`@${path.trim()} `);
    }
  };

  return (
    <div>
      {/* 隐藏的原生文件输入 */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* 附件缩略图预览条 */}
      {attachment && (
        <div className="flex items-center gap-2 mb-2 p-1.5 px-2.5 rounded-xl bg-white/[0.04] border border-white/10 w-fit max-w-full">
          <div className="w-7 h-7 rounded-lg overflow-hidden bg-black/40 border border-white/10 shrink-0 flex items-center justify-center">
            <img
              src={`data:${attachment.mediaType};base64,${attachment.data}`}
              alt={attachment.name}
              className="w-full h-full object-cover"
            />
          </div>
          <span className="text-[11.5px] font-mono text-[#cbd5e1] truncate max-w-[160px]">
            {attachment.name}
          </span>
          <button
            type="button"
            onClick={onRemove}
            className="w-6 h-6 rounded-md hover:bg-white/10 flex items-center justify-center text-[#94a3b8] hover:text-white cursor-pointer studio-tap"
            title="移除附件"
          >
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  );
};
