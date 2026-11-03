import type { SVGProps } from 'react'

/** Steering wheel icon (not part of lucide), drawn in the same 24px stroke style. */
export function SteeringWheel({
  size = 24,
  ...props
}: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="2" />
      <path d="M2.4 10.5C6 10 9 10 10 12M21.6 10.5C18 10 15 10 14 12M12 14v7.8" />
    </svg>
  )
}
