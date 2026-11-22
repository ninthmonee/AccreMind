import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/overlays';
import { Label, Textarea } from './ui/primitives';

/** 需要写明依据的操作（标记失效、解除反证、重新评估、反馈有误）统一用这个对话框，代替原生 prompt。 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  label = '依据',
  placeholder,
  confirmLabel = '确认',
  danger = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  label?: string;
  placeholder?: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: (reason: string) => Promise<void> | void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setText('');
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-6">
        <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
        {description && <DialogDescription className="mt-1 text-sm text-muted-foreground">{description}</DialogDescription>}
        <div className="mt-4 grid gap-1.5">
          <Label htmlFor="reason-text">{label}</Label>
          <Textarea id="reason-text" autoFocus rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            variant={danger ? 'destructive' : 'default'}
            disabled={!text.trim() || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(text.trim());
                onOpenChange(false);
              } catch {
                /* 错误已由调用方提示，保留对话框便于修改后重试 */
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 统一 diff 展示：新增 / 删除 / 区块头分色，行号前缀不选中。 */
export function DiffView({ diff, truncated, className }: { diff: string; truncated?: boolean; className?: string }) {
  if (!diff.trim()) return <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">没有可对照的代码差异</p>;
  const lines = diff.split('\n').slice(0, 400);
  return (
    <div className={className}>
      <pre className="max-h-80 overflow-auto rounded-lg border bg-background/60 py-2 font-mono text-[12px] leading-[1.6]">
        {lines.map((l, i) => {
          const cls = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ')
            ? 'text-muted-foreground'
            : l.startsWith('@@')
              ? 'bg-info/10 text-info'
              : l.startsWith('+')
                ? 'bg-success/10 text-success'
                : l.startsWith('-')
                  ? 'bg-danger/10 text-danger'
                  : 'text-foreground/80';
          return (
            <div key={i} className={`px-3 ${cls}`}>
              {l || ' '}
            </div>
          );
        })}
      </pre>
      {truncated && <p className="mt-1 text-xs text-muted-foreground">差异过长，只显示了前一部分。</p>}
    </div>
  );
}
