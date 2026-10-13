import React from 'react';
import { Wrench } from 'lucide-react';

const ToolCallView: React.FC<{ call: any }> = ({ call }) => {
  const [open, setOpen] = React.useState(false);
  const args = call.arguments ?? {};

  return (
    <div className="bg-card/80 border border-border/80 rounded-lg text-[11.5px] font-mono overflow-hidden shadow-sm">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-2 w-full hover:bg-accent/40 transition-colors text-left"
      >
        <Wrench className="w-3 h-3 text-primary shrink-0" />
        <span className="text-cyan-300 font-semibold">{call.name}</span>
        <span className="text-muted-foreground truncate flex-1">
          {typeof args === 'string' ? args : JSON.stringify(args).slice(0, 80)}
        </span>
        <span className="text-muted-foreground">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <pre className="px-2.5 pb-2 text-[11px] text-foreground/75 whitespace-pre-wrap break-all max-h-40 overflow-y-auto border-t border-border/60">
          {typeof args === 'string' ? args : JSON.stringify(args, null, 2)}
        </pre>
      )}
    </div>
  );
};

export default ToolCallView;
