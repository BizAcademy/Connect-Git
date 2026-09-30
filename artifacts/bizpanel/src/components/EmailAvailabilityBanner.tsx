import { useQuery } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import {
  EMAIL_BANNER_QUERY_KEY,
  fetchEmailBanner,
} from "@/lib/emailBanner";
import "./EmailAvailabilityBanner.css";

export function EmailAvailabilityTicker({
  message,
  preview = false,
}: {
  message: string;
  preview?: boolean;
}) {
  const copy = message.trim();
  if (!copy) return null;

  return (
    <div
      className={`email-availability-banner${preview ? " email-availability-banner--preview" : ""}`}
      role="region"
      aria-label="Information sur la disponibilité des e-mails"
      tabIndex={0}
      data-testid={preview ? "preview-email-banner" : "email-availability-banner"}
    >
      <Mail className="email-availability-banner__icon" size={17} aria-hidden="true" />
      <span className="sr-only">{copy}</span>
      <div className="email-availability-banner__viewport" aria-hidden="true">
        <div className="email-availability-banner__track">
          <span className="email-availability-banner__copy">{copy}</span>
          <span className="email-availability-banner__copy">{copy}</span>
        </div>
      </div>
    </div>
  );
}

export function EmailAvailabilityBanner() {
  const { data } = useQuery({
    queryKey: EMAIL_BANNER_QUERY_KEY,
    queryFn: fetchEmailBanner,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  if (!data?.active) return null;
  return <EmailAvailabilityTicker message={data.message} />;
}