import styles from './StatusPill.module.css';

export type PipelineStatus =
  | 'queued'
  | 'preprocessing'
  | 'transcribing'
  | 'parsing'
  | 'published'
  | 'flagged'
  | 'failed';

const LABEL: Record<PipelineStatus, string> = {
  queued: 'Queued',
  preprocessing: 'Preprocessing',
  transcribing: 'Transcribing',
  parsing: 'Parsing',
  published: 'Published',
  flagged: 'Flagged for review',
  failed: 'Failed',
};

interface StatusPillProps {
  status: PipelineStatus;
  pulse?: boolean;
}

export function StatusPill({ status, pulse = false }: StatusPillProps) {
  return (
    <span
      className={[styles.pill, styles[status], pulse ? styles.pulse : ''].filter(Boolean).join(' ')}
    >
      <span className={styles.dot} aria-hidden />
      <span className={styles.label}>{LABEL[status]}</span>
    </span>
  );
}
