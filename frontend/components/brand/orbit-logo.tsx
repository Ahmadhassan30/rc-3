import Image from "next/image";

import { cn } from "@/lib/utils";

export function OrbitLogo({
  size,
  className,
  priority = false,
}: {
  size: number;
  className?: string;
  priority?: boolean;
}) {
  return (
    <span className={cn("relative inline-flex shrink-0", className)} style={{ width: size, height: size }}>
      <Image
        src="/orbit-logo-light.png"
        alt="Orbit"
        width={size}
        height={size}
        className="size-full object-contain dark:hidden"
        priority={priority}
      />
      <Image
        src="/orbit-logo-dark-v2.png"
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        className="hidden size-full object-contain dark:block"
        priority={priority}
      />
    </span>
  );
}
