import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';

interface Props {
  content: string;
}

export const MarkdownView: React.FC<Props> = ({ content }) => {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const handleCopy = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  // Split into lines/blocks
  const blocks = content.split(/(```[\s\S]*?```)/g);

  return (
    <div className="space-y-2 text-[14.5px] leading-[22px] text-[#151517] break-words">
      {blocks.map((block, idx) => {
        if (block.startsWith('```')) {
          const match = block.match(/```(\w*)\n([\s\S]*?)```/);
          const lang = match ? match[1] : '';
          const code = match ? match[2].trim() : block.slice(3, -3).trim();

          return (
            <div
              key={idx}
              className="my-2 rounded-xl bg-[#1e1e24] text-[#f1f3f5] overflow-hidden border border-[#2c2c2e] text-xs font-mono"
            >
              <div className="flex items-center justify-between px-3 py-1.5 bg-[#252528] border-b border-[#2c2c2e] text-[#8a8d96]">
                <span className="font-semibold uppercase tracking-wider">{lang || 'CODE'}</span>
                <button
                  type="button"
                  onClick={() => handleCopy(code, idx)}
                  className="flex items-center gap-1 hover:text-white transition-colors cursor-pointer"
                >
                  {copiedIndex === idx ? (
                    <>
                      <Check size={12} className="text-[#22c55e]" />
                      <span>已复制</span>
                    </>
                  ) : (
                    <>
                      <Copy size={12} />
                      <span>复制</span>
                    </>
                  )}
                </button>
              </div>
              <pre className="p-3 overflow-x-auto text-[13px] leading-[20px]">
                <code>{code}</code>
              </pre>
            </div>
          );
        }

        // Render standard markdown text paragraphs & lists
        const paragraphs = block.split(/\n\n+/);
        return (
          <React.Fragment key={idx}>
            {paragraphs.map((p, pIdx) => {
              if (!p.trim()) return null;

              const lines = p.split('\n');
              return (
                <div key={pIdx} className="space-y-1">
                  {lines.map((line, lIdx) => {
                    // Check for checklist items (- [x] or - [ ])
                    const checkMatch = line.match(/^[-*]\s*\[([ xX])\]\s*(.*)$/);
                    if (checkMatch) {
                      const isChecked = checkMatch[1].toLowerCase() === 'x';
                      const text = checkMatch[2];
                      return (
                        <div key={lIdx} className="flex items-start gap-2 py-0.5">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            readOnly
                            className="mt-1 h-3.5 w-3.5 rounded text-[#0060df] accent-[#0060df] cursor-default"
                          />
                          <span className={isChecked ? 'line-through text-[#717182]' : ''}>
                            {formatInline(text)}
                          </span>
                        </div>
                      );
                    }

                    // Bullet list
                    if (line.match(/^[-*]\s+/)) {
                      return (
                        <div key={lIdx} className="flex items-start gap-2 pl-2">
                          <span className="text-[#0060df] mt-1 text-xs">•</span>
                          <span>{formatInline(line.replace(/^[-*]\s+/, ''))}</span>
                        </div>
                      );
                    }

                    // Blockquote
                    if (line.startsWith('>')) {
                      return (
                        <blockquote
                          key={lIdx}
                          className="border-l-3 border-[#0060df] pl-3 py-1 my-1 italic text-[#52525e] bg-[#f5fbff] rounded-r-md"
                        >
                          {formatInline(line.replace(/^>\s*/, ''))}
                        </blockquote>
                      );
                    }

                    return <div key={lIdx}>{formatInline(line)}</div>;
                  })}
                </div>
              );
            })}
          </React.Fragment>
        );
      })}
    </div>
  );
};

// Simple inline markdown formatting (bold, code, links)
function formatInline(str: string): React.ReactNode {
  const parts = str.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code
          key={index}
          className="px-1.5 py-0.5 mx-0.5 bg-[#f1f3f5] text-[#005fb8] rounded-md font-mono text-[13px] border border-[#e5e5e5]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={index} className="font-semibold text-[#151517]">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return part;
  });
}
