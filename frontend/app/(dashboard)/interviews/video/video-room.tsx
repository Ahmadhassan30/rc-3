"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft02Icon, Copy01Icon, Video01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { isJitsiMeetingUrl, JITSI_DOMAIN } from "@/lib/jitsi";

const JitsiMeeting = dynamic(
  () => import("@jitsi/react-sdk").then((module) => module.JitsiMeeting),
  { ssr: false },
);

export function VideoRoom() {
  const params = useSearchParams();
  const url = params.get("url");
  const [copied, setCopied] = useState(false);

  if (!url || !isJitsiMeetingUrl(url)) {
    return (
      <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center bg-slate-50 p-6 dark:bg-neutral-950">
        <section className="max-w-md rounded-lg border border-slate-300 bg-white p-8 text-center dark:border-neutral-700 dark:bg-neutral-900">
          <HugeiconsIcon icon={Video01Icon} className="mx-auto size-10 text-theme" />
          <h1 className="mt-4 text-lg font-semibold text-slate-900 dark:text-neutral-100">Video room unavailable</h1>
          <p className="mt-2 text-sm text-slate-500 dark:text-neutral-400">Open the video room from a scheduled Jitsi interview.</p>
          <Button render={<Link href="/interviews" />} className="mt-6 gap-2 bg-theme text-white hover:bg-theme-hover">
            <HugeiconsIcon icon={ArrowLeft02Icon} className="size-4" /> Back to interviews
          </Button>
        </section>
      </main>
    );
  }

  const room = new URL(url).pathname.slice(1);
  const copy = async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <main className="flex min-h-[calc(100vh-3.5rem)] flex-col bg-[#10141c] text-white">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <Button render={<Link href="/interviews" />} variant="ghost" className="size-9 p-0 text-white/70 hover:bg-white/10 hover:text-white" aria-label="Back to interviews">
            <HugeiconsIcon icon={ArrowLeft02Icon} className="size-5" />
          </Button>
          <div>
            <p className="text-sm font-semibold">Orbit video interview</p>
            <p className="text-xs text-white/50">Room: {room}</p>
          </div>
        </div>
        <Button onClick={copy} variant="ghost" className="h-9 gap-2 text-white/80 hover:bg-white/10 hover:text-white">
          <HugeiconsIcon icon={Copy01Icon} className="size-4" /> {copied ? "Copied" : "Copy invite link"}
        </Button>
      </header>
      <div className="min-h-0 flex-1 p-2 sm:p-4">
        <div className="h-[calc(100vh-8rem)] min-h-[520px] overflow-hidden rounded-lg border border-white/10 bg-black">
          <JitsiMeeting
            domain={JITSI_DOMAIN}
            roomName={room}
            configOverwrite={{ prejoinPageEnabled: true, disableDeepLinking: true }}
            interfaceConfigOverwrite={{ MOBILE_APP_PROMO: false, SHOW_JITSI_WATERMARK: false }}
            userInfo={{ displayName: "Orbit interviewer", email: "interviewer@orbit.local" }}
            getIFrameRef={(iframe) => {
              iframe.style.height = "100%";
              iframe.style.width = "100%";
            }}
          />
        </div>
      </div>
    </main>
  );
}