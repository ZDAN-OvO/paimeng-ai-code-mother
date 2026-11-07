/**
 * Paimeng 的标记。形状与 `public/logo/paimeng-mark.svg` 一致，用内联 SVG 写是为了跟随主题：
 * 浅色下是深色圆角方块，深色下保留深色底并补一圈描边，避免在 stone-950 背景上消失。
 */
export function PaimengMark({
  size = 28,
  className,
  title,
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 192 192"
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <rect
        x="7"
        y="7"
        width="178"
        height="178"
        rx="44"
        strokeWidth={2}
        className="fill-stone-900 stroke-transparent dark:stroke-stone-700"
      />
      <path
        fillRule="evenodd"
        strokeWidth={4}
        strokeLinejoin="round"
        className="fill-stone-50 stroke-stone-50"
        d="M44 44 H148 L118 106 H78 V148 H44 Z M78 62 H122 L102 90 H78 Z"
      />
    </svg>
  );
}
