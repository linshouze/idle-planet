import { App as AntApp, Button } from 'antd';

/** 公司内网多为 HTTP，navigator.clipboard 在非安全上下文不可用，所以保留 execCommand 兜底。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续用兜底方式 */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

export function Contact({ label, value }: { label: string; value: string | null }) {
  const { message } = AntApp.useApp();
  if (!value) return null;
  return (
    <div>
      {label}
      <div className="contact">
        <span>{value}</span>
        <Button
          size="small"
          type="link"
          onClick={async () => {
            if (await copyText(value)) message.success('已复制');
            else message.error('复制失败，请手动选择文字');
          }}
        >
          复制
        </Button>
      </div>
    </div>
  );
}
