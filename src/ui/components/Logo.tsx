import markUrl from '@/assets/brand/roadpilot-mark.svg'

/**
 * Official RoadPilot logo: the brand mark followed by the wordmark.
 * The mark comes from the single source asset `src/assets/brand/roadpilot-mark.svg`;
 * the desktop app icon (`src-tauri/roadpilot-icon.svg`) embeds the same geometry.
 */
export function Logo({ className = '' }: { className?: string }) {
  return (
    <span className={`logo ${className}`.trim()}>
      <img className="logo-mark" src={markUrl} alt="" draggable={false} />
      <span className="logo-wordmark">RoadPilot</span>
    </span>
  )
}
