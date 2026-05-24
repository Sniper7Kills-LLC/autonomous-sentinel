'use client';

import { useEffect, useState } from 'react';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { Button } from '@/components/ui/Button';
import { Badge, MessageTypeBadge } from '@/components/ui/Badge';
import { StatusPill } from '@/components/ui/StatusPill';
import { Alert } from '@/components/ui/Alert';
import {
  Card,
  CardHeader,
  CardTitle,
  CardSubtitle,
  CardBody,
  CardFooter,
} from '@/components/ui/Card';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Checkbox, Radio } from '@/components/ui/Checkbox';
import { Switch } from '@/components/ui/Switch';
import { DataTable, Thead, Tbody, Tr, Th, Td } from '@/components/ui/Table';
import { VoteTally } from '@/components/ui/VoteTally';
import { AudioPlayerSkeleton } from '@/components/ui/AudioPlayerSkeleton';
import { Pagination } from '@/components/ui/Pagination';
import { ModalHeader } from '@/components/ui/ModalHeader';
import { Footer } from '@/components/ui/Footer';
import { MessageDetail, type ParsedMessage } from '@/components/messages/MessageDetail';
import styles from './page.module.css';

const SAMPLE_MESSAGES: ParsedMessage[] = [
  {
    id: 'm-1',
    type: 'ALLSTATIONS',
    broadcastTs: '2026-05-24 03:14:22Z',
    sender: 'MAINSAIL',
    receiver: 'ALL STATIONS',
    frequency: '11.175 USB',
    repetitions: 2,
    confidence: 0.92,
    body: {
      kind: 'ALLSTATIONS',
      preamble: '7FTBE4',
      characters: '7FTBE47KQ2BHC9LMP3JXR6VWATBDUN5',
      auth: 'XW',
    },
  },
  {
    id: 'm-2',
    type: 'ALLSTATIONS',
    broadcastTs: '2026-05-24 02:48:11Z',
    sender: 'MAINSAIL',
    receiver: 'ALL STATIONS',
    frequency: '11.175 USB',
    repetitions: 1,
    confidence: 0.71,
    body: {
      kind: 'ALLSTATIONS',
      preamble: 'A7B2J9',
      characters: 'A7B2J97H4Q1F2TK9MP3JX',
      auth: '4K',
    },
  },
  {
    id: 'm-3',
    type: 'SKYKING',
    broadcastTs: '2026-05-24 01:22:03Z',
    sender: 'MAINSAIL',
    receiver: 'ANY AIRBORNE COMMAND',
    frequency: '11.175 USB',
    repetitions: 3,
    confidence: 0.94,
    body: {
      kind: 'SKYKING',
      time: '14',
      codeword: 'BEARS',
      auth: '9D',
    },
  },
  {
    id: 'm-4',
    type: 'SKYBIRD',
    broadcastTs: '2026-05-24 00:41:18Z',
    sender: 'OFFUTT',
    receiver: 'AIR FORCE ONE',
    frequency: '11.175 USB',
    confidence: 0.88,
    body: {
      kind: 'SKYBIRD',
      preamble: 'Skybird Skybird · Any aircraft',
      text: 'Pass your traffic on this frequency. Standby for further instruction. Authentication Lima Tango.',
    },
  },
  {
    id: 'm-5',
    type: 'SKYMASTER',
    broadcastTs: '2026-05-23 23:55:42Z',
    sender: 'ANDREWS',
    receiver: 'SKYMASTER',
    frequency: '15.016 USB',
    repetitions: 1,
    confidence: 0.42,
    body: {
      kind: 'SKYMASTER',
      preamble: 'Skymaster · Standby traffic',
      text: 'Unable to copy primary. Request relay via secondary node. Stand by.',
    },
  },
  {
    id: 'm-6',
    type: 'RADIOCHECK',
    broadcastTs: '2026-05-23 22:10:19Z',
    sender: 'CAPE RADIO',
    receiver: 'MAINSAIL',
    frequency: '8.992 USB',
    confidence: 0.99,
    body: {
      kind: 'RADIOCHECK',
      result: 'LOUD AND CLEAR',
    },
  },
  {
    id: 'm-7',
    type: 'BACKEND',
    broadcastTs: '2026-05-23 21:02:48Z',
    sender: '',
    receiver: '',
    frequency: '',
    confidence: 1,
    body: {
      kind: 'BACKEND',
      admin: 'sniper7kills',
      role: 'Site administrator',
      severity: 'info',
      text: 'Scheduled maintenance window 2026-05-26 04:00–05:00Z. Brief pause in transcription pipeline; uploads queued and processed on resume. No action required.',
    },
  },
  {
    id: 'm-8',
    type: 'DISREGARDED',
    broadcastTs: '2026-05-23 20:15:30Z',
    sender: 'MAINSAIL',
    receiver: 'ALL STATIONS',
    frequency: '11.175 USB',
    confidence: 0.97,
    body: {
      kind: 'DISREGARDED',
      text: 'Originally tagged ALLSTATIONS, body 7FTBE4… 30 char. Mainsail issued retraction at 20:18Z; underlying transmission marked disregarded by net control.',
    },
  },
];

const MESSAGES: {
  ts: string;
  sender: string;
  receiver: string;
  type: 'SKYKING' | 'SKYBIRD' | 'SKYMASTER' | 'ALLSTATIONS' | 'RADIOCHECK' | 'BACKEND';
  freq: string;
  body: string;
  conf: number;
}[] = [
  {
    ts: '2026-05-24 03:14:22Z',
    sender: 'MAINSAIL',
    receiver: 'SKYKING',
    type: 'SKYKING',
    freq: '8.992 USB',
    body: 'B7 K1 4F 8N 2J — TIME 14',
    conf: 0.94,
  },
  {
    ts: '2026-05-24 02:48:11Z',
    sender: 'MAINSAIL',
    receiver: 'ALL STATIONS',
    type: 'ALLSTATIONS',
    freq: '11.175 USB',
    body: 'A7B2J9 7H 4Q 1F 2T — AUTH 9D',
    conf: 0.71,
  },
  {
    ts: '2026-05-24 01:22:03Z',
    sender: 'OFFUTT',
    receiver: 'AIR FORCE ONE',
    type: 'SKYBIRD',
    freq: '11.175 USB',
    body: 'PASS YOUR TRAFFIC',
    conf: 0.88,
  },
  {
    ts: '2026-05-23 23:55:42Z',
    sender: 'ANDREWS',
    receiver: 'SKYMASTER',
    type: 'SKYMASTER',
    freq: '15.016 USB',
    body: '5T 9P 2B 7K 1Q — TIME 55',
    conf: 0.42,
  },
  {
    ts: '2026-05-23 22:10:19Z',
    sender: 'CAPE RADIO',
    receiver: 'TEST',
    type: 'RADIOCHECK',
    freq: '8.992 USB',
    body: 'RADIO CHECK — LOUD AND CLEAR',
    conf: 0.99,
  },
];

export default function StyleGuidePage() {
  const [page, setPage] = useState(3);
  const [notify, setNotify] = useState(true);
  const [bio, setBio] = useState(
    'Operator since 2019, capturing HFGCS traffic from EM12.\nContact via DM if you need decode help.',
  );

  return (
    <div className={styles.shell}>
      <div className={styles.classification}>
        <span className={styles.classText}>
          {'// PUBLIC RELEASE · EAM ARCHIVE · OSINT · UNCLASSIFIED //'}
        </span>
      </div>
      <Header />
      <main className={styles.main}>
        <Section
          id="overview"
          eyebrow="01 — Overview"
          title="Design system preview"
          lede="A self-contained style guide rendering every primitive that ships with the v4 web app. Toggle theme upper-right. Numbers are sample data, not live traffic."
        >
          <div className={styles.statGrid}>
            <Stat label="Messages catalogued" value="48,217" trend="+312 wk" />
            <Stat label="Active SDRs" value="14" trend="+1" tone="info" />
            <Stat label="Pending review" value="7" trend="−3" tone="warn" />
            <Stat label="Pipeline SLA" value="22m" trend="under 30m" tone="success" />
          </div>
        </Section>

        <Section
          id="type"
          eyebrow="02 — Typography"
          title="Type scale"
          lede="IBM Plex Sans for prose; IBM Plex Mono for callsigns, frequencies, timestamps, and IDs. H5–H6 uppercase mono behaves as small caps for tabular section labels."
        >
          <div className={styles.typeStack}>
            <div className={styles.typeRow}>
              <span className={styles.typeKey}>H1 · 40px</span>
              <h1>The quick brown fox jumps</h1>
            </div>
            <div className={styles.typeRow}>
              <span className={styles.typeKey}>H2 · 32px</span>
              <h2>The quick brown fox jumps</h2>
            </div>
            <div className={styles.typeRow}>
              <span className={styles.typeKey}>H3 · 24px</span>
              <h3>The quick brown fox jumps</h3>
            </div>
            <div className={styles.typeRow}>
              <span className={styles.typeKey}>H4 · 20px</span>
              <h4>The quick brown fox jumps</h4>
            </div>
            <div className={styles.typeRow}>
              <span className={styles.typeKey}>H5 · caps</span>
              <h5>Section label</h5>
            </div>
            <div className={styles.typeRow}>
              <span className={styles.typeKey}>H6 · mono caps</span>
              <h6>Subsection label</h6>
            </div>
            <div className={styles.typeRow}>
              <span className={styles.typeKey}>Body</span>
              <p>
                Emergency Action Messages are six-letter codewords broadcast on HFGCS. The
                cataloging pipeline ingests SDR audio, transcribes with Whisper, and parses with
                rules + Bedrock fallback. Body copy stays at 16 / 1.55 with a 70-character max-width
                for comfortable scan.
              </p>
            </div>
            <div className={styles.typeRow}>
              <span className={styles.typeKey}>Mono</span>
              <p className="mono">
                MAINSAIL → ALL STATIONS · 11.175 USB · 03:14:22Z · B7 K1 4F 8N 2J · AUTH 9D
              </p>
            </div>
            <div className={styles.typeRow}>
              <span className={styles.typeKey}>Inline</span>
              <p>
                Inline <code>code</code>, plus a keyboard hint — <kbd>Ctrl</kbd> + <kbd>K</kbd>{' '}
                opens search.
              </p>
            </div>
          </div>
        </Section>

        <Section
          id="palette"
          eyebrow="03 — Palette"
          title="Color tokens"
          lede="Gunmetal surfaces dominate. Amber primary signals action; cyan info, phosphor success, deep red danger. Light theme is field-manual bone with the same accent hues shifted for AA contrast."
        >
          <div className={styles.palette}>
            <Swatch name="--color-bg" />
            <Swatch name="--color-surface" />
            <Swatch name="--color-surface-2" />
            <Swatch name="--color-surface-3" />
            <Swatch name="--color-border" />
            <Swatch name="--color-border-strong" />
            <Swatch name="--color-fg" />
            <Swatch name="--color-fg-muted" />
            <Swatch name="--color-accent" />
            <Swatch name="--color-info" />
            <Swatch name="--color-success" />
            <Swatch name="--color-warn" />
            <Swatch name="--color-danger" />
          </div>
        </Section>

        <Section
          id="buttons"
          eyebrow="04 — Buttons"
          title="Actions"
          lede="Three sizes × five variants. All buttons render uppercase mono-leaning sans with subtle press feedback."
        >
          <div className={styles.row}>
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Decommission</Button>
            <Button variant="success">Publish</Button>
          </div>
          <div className={styles.row}>
            <Button size="sm">Small</Button>
            <Button size="md">Medium</Button>
            <Button size="lg">Large</Button>
            <Button loading>Transcribing</Button>
            <Button disabled>Disabled</Button>
          </div>
          <div className={styles.row}>
            <Button leadingIcon={<IconUpload />} variant="primary">
              Upload recording
            </Button>
            <Button variant="secondary" trailingIcon={<IconArrow />}>
              Open detail
            </Button>
          </div>
        </Section>

        <Section
          id="badges"
          eyebrow="05 — Badges + pipeline status"
          title="Status signaling"
          lede="Aggregate counts (votes, type chips) read the same color the rest of the surface uses. Pipeline pills carry a status dot and pulse when the step is currently running."
        >
          <div className={styles.row}>
            <Badge>Member</Badge>
            <Badge tone="accent">Supporter</Badge>
            <Badge tone="info">Moderator</Badge>
            <Badge tone="success">Verified</Badge>
            <Badge tone="warn">Flagged</Badge>
            <Badge tone="danger">Banned</Badge>
            <Badge tone="info" outline>
              Outline
            </Badge>
          </div>
          <div className={styles.row}>
            <MessageTypeBadge type="SKYKING" />
            <MessageTypeBadge type="SKYBIRD" />
            <MessageTypeBadge type="SKYMASTER" />
            <MessageTypeBadge type="ALLSTATIONS" />
            <MessageTypeBadge type="RADIOCHECK" />
            <MessageTypeBadge type="BACKEND" />
            <MessageTypeBadge type="DISREGARDED" />
            <MessageTypeBadge type="OTHER" />
          </div>
          <div className={styles.row}>
            <StatusPill status="queued" />
            <StatusPill status="preprocessing" />
            <StatusPill status="transcribing" pulse />
            <StatusPill status="parsing" />
            <StatusPill status="published" />
            <StatusPill status="flagged" />
            <StatusPill status="failed" />
          </div>
        </Section>

        <Section
          id="alerts"
          eyebrow="06 — Alerts"
          title="Banners"
          lede="Left rule communicates tone at a glance. Title + body + optional inline actions."
        >
          <div className={styles.stack}>
            <Alert tone="info" title="Pipeline backlog: 4 recordings queued">
              Transcription is on-time. Expect publish within the 30-minute SLA.
            </Alert>
            <Alert
              tone="success"
              title="Manual transcript accepted"
              actions={
                <Button size="sm" variant="ghost">
                  View revision
                </Button>
              }
            >
              Your correction was accepted by majority vote (7 to 1).
            </Alert>
            <Alert tone="warn" title="Low confidence (0.42)">
              This Message was auto-published flagged. Community vote will determine the canonical
              reading.
            </Alert>
            <Alert
              tone="danger"
              title="Transcription failed"
              actions={
                <>
                  <Button size="sm" variant="ghost">
                    Retry
                  </Button>
                  <Button size="sm" variant="danger">
                    Manual transcript
                  </Button>
                </>
              }
            >
              Whisper returned non-English output above the rejection threshold. The recording is
              preserved for manual transcription.
            </Alert>
          </div>
        </Section>

        <Section
          id="tables"
          eyebrow="07 — Tables"
          title="Messages list"
          lede="Tabular numerics, monospace freq + ID columns, hover-row tint. Header cells uppercase mono. Confidence column right-aligned."
        >
          <DataTable striped>
            <Thead>
              <Tr>
                <Th>Timestamp (UTC)</Th>
                <Th>Type</Th>
                <Th>Sender</Th>
                <Th>Receiver</Th>
                <Th>Freq</Th>
                <Th>Body</Th>
                <Th numeric>Conf</Th>
                <Th>Status</Th>
              </Tr>
            </Thead>
            <Tbody>
              {MESSAGES.map((m) => (
                <Tr key={m.ts}>
                  <Td mono>{m.ts}</Td>
                  <Td>
                    <MessageTypeBadge type={m.type} />
                  </Td>
                  <Td mono>{m.sender}</Td>
                  <Td mono>{m.receiver}</Td>
                  <Td mono>{m.freq}</Td>
                  <Td mono>{m.body}</Td>
                  <Td
                    numeric
                    mono
                    style={{
                      color:
                        m.conf >= 0.8
                          ? 'var(--color-success)'
                          : m.conf >= 0.6
                            ? 'var(--color-warn)'
                            : 'var(--color-danger)',
                    }}
                  >
                    {m.conf.toFixed(2)}
                  </Td>
                  <Td>
                    {m.conf >= 0.8 ? (
                      <StatusPill status="published" />
                    ) : (
                      <StatusPill status="flagged" />
                    )}
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </DataTable>
          <div className={styles.tableFooter}>
            <span className={styles.mono}>5 of 48,217 results</span>
            <Pagination page={page} totalPages={42} onChange={setPage} />
          </div>
        </Section>

        <Section id="lists" eyebrow="08 — Lists" title="Ordered, unordered, definition">
          <div className={styles.twoCol}>
            <div>
              <h5>Pipeline stages</h5>
              <ol>
                <li>Upload to S3</li>
                <li>Pre-process (silence trim, transcode)</li>
                <li>Transcribe (Whisper / OpenAI / Amazon / Bedrock)</li>
                <li>Linguistic Logic (rules + Bedrock fallback)</li>
                <li>Auto-publish + community review</li>
              </ol>

              <h5 style={{ marginTop: 'var(--sp-4)' }}>Supported modulations</h5>
              <ul>
                <li>USB (upper sideband, primary)</li>
                <li>LSB (lower sideband, niche)</li>
                <li>AM (legacy)</li>
                <li>FM (rare for EAM)</li>
              </ul>
            </div>
            <div>
              <h5>Definition list</h5>
              <dl>
                <dt>Skyking</dt>
                <dd>Highest-priority EAM, addressed to airborne nuclear command.</dd>
                <dt>Skybird</dt>
                <dd>Routing channel between command and an aircraft holding position.</dd>
                <dt>Mainsail</dt>
                <dd>HFGCS net control. Originates most broadcasts on 11.175 USB.</dd>
                <dt>Auth</dt>
                <dd>Two-character authenticator suffix on a Skyking message.</dd>
              </dl>
            </div>
          </div>
        </Section>

        <Section
          id="forms"
          eyebrow="09 — Forms"
          title="Inputs"
          lede="Inputs and textarea share one base style; selects render with a custom chevron; toggles + checkboxes + radios share an aesthetic family."
        >
          <div className={styles.formGrid}>
            <Field label="Callsign" htmlFor="cs" required hint="Free-form or pick from dictionary.">
              <Input id="cs" placeholder="MAINSAIL" defaultValue="MAINSAIL" />
            </Field>
            <Field label="Frequency" htmlFor="fq" hint="USB / LSB / AM / FM">
              <Select id="fq" defaultValue="11.175">
                <option value="11.175">11.175 USB</option>
                <option value="8.992">8.992 USB</option>
                <option value="15.016">15.016 USB</option>
                <option value="4.724">4.724 USB</option>
              </Select>
            </Field>
            <Field label="Invalid example" htmlFor="bad" error="Required field">
              <Input id="bad" invalid placeholder="leave blank" />
            </Field>
            <Field label="Disabled" htmlFor="off">
              <Input id="off" disabled defaultValue="locked-by-system" />
            </Field>
            <div className={styles.formSpan}>
              <Field
                label="Operator bio"
                htmlFor="bio"
                hint="Markdown supported. Up to 1200 characters."
              >
                <Textarea id="bio" rows={5} value={bio} onChange={(e) => setBio(e.target.value)} />
              </Field>
            </div>
          </div>

          <div className={styles.row}>
            <Checkbox id="c1" label="Subscribe to weekly digest" defaultChecked />
            <Checkbox id="c2" label="Flag low-confidence messages" />
            <Checkbox id="c3" label="Disabled checkbox" disabled defaultChecked />
          </div>
          <div className={styles.row}>
            <Radio name="modulation" id="r1" label="USB" defaultChecked />
            <Radio name="modulation" id="r2" label="LSB" />
            <Radio name="modulation" id="r3" label="AM" />
            <Radio name="modulation" id="r4" label="FM" />
          </div>
          <div className={styles.row}>
            <Switch
              id="s1"
              label="Email notifications"
              checked={notify}
              onChange={(e) => setNotify(e.target.checked)}
            />
            <Switch id="s2" label="Discord webhook" />
            <Switch id="s3" label="Web push (canned tone)" defaultChecked />
          </div>
        </Section>

        <Section
          id="message-detail"
          eyebrow="10 — Message detail"
          title="Per-type rendering"
          lede="Every type beyond OTHER has a known format. The renderer decodes NATO phonetic to characters, surfaces the char-count badge against the 30-char canonical (auto-flagged when off), and tags repeated broadcasts with a repetition badge. Skykings render letter-groups + time + auth slots; Skybird/Skymaster wrap free-form traffic; RADIOCHECK shows the result line; DISREGARDED stamps."
        >
          <div className={styles.msgGrid}>
            {SAMPLE_MESSAGES.map((m) => (
              <MessageDetail key={m.id} message={m} />
            ))}
          </div>
        </Section>

        <Section
          id="cards"
          eyebrow="11 — Cards"
          title="Surfaces"
          lede="Cards carry an optional top-edge stripe in the message-type color. Use the title / subtitle pair for tabular metadata."
        >
          <div className={styles.cardGrid}>
            <Card stripe="var(--type-skyking)">
              <CardHeader>
                <CardSubtitle>SKYKING · 2026-05-24 03:14:22Z</CardSubtitle>
                <CardTitle>MAINSAIL → SKYKING</CardTitle>
              </CardHeader>
              <CardBody>
                <p className="mono">B7 K1 4F 8N 2J — TIME 14</p>
                <p>Captured by 3 SDRs · 11.175 USB · auto-published at confidence 0.94.</p>
              </CardBody>
              <CardFooter>
                <Badge tone="success">0.94</Badge>
                <Button size="sm" variant="ghost">
                  Open
                </Button>
              </CardFooter>
            </Card>

            <Card stripe="var(--type-radiocheck)">
              <CardHeader>
                <CardSubtitle>SDR · EM12 grid</CardSubtitle>
                <CardTitle>cape-rx-01</CardTitle>
              </CardHeader>
              <CardBody>
                <dl>
                  <dt>Owner</dt>
                  <dd>sniper7kills</dd>
                  <dt>Visibility</dt>
                  <dd>Public, ±50 km granularity</dd>
                  <dt>Uptime</dt>
                  <dd className="mono tnum">99.4% (90d)</dd>
                  <dt>Last upload</dt>
                  <dd className="mono">4 min ago</dd>
                </dl>
              </CardBody>
              <CardFooter>
                <Badge tone="success">Operational</Badge>
                <Button size="sm" variant="ghost">
                  Manage
                </Button>
              </CardFooter>
            </Card>

            <Card stripe="var(--type-skymaster)">
              <CardHeader>
                <CardSubtitle>Transmitter · admin-managed</CardSubtitle>
                <CardTitle>Offutt AFB · USAF HFGCS</CardTitle>
              </CardHeader>
              <CardBody>
                <p>
                  Primary HFGCS site for STRATCOM traffic. Pre-populated from public sources and
                  pinned to the propagation map.
                </p>
              </CardBody>
              <CardFooter>
                <Badge>USA</Badge>
                <Button size="sm" variant="ghost">
                  Edit
                </Button>
              </CardFooter>
            </Card>
          </div>
        </Section>

        <Section
          id="audio"
          eyebrow="12 — Audio player"
          title="Recording playback"
          lede="Waveform skeleton + scrubber + transport. Real player wires Opus playback + word-level timestamps for scrub-to-text sync in a downstream issue."
        >
          <AudioPlayerSkeleton
            title="MAINSAIL → SKYKING · 03:14:22Z"
            meta="11.175 USB · captured by cape-rx-01 · 3:04"
            duration={184}
          />
        </Section>

        <Section
          id="votes"
          eyebrow="13 — Community validation"
          title="Vote tallies"
          lede="Public users see aggregate counts only — individual votes are mod-visible. Leader bar is rendered in the accent."
        >
          <div className={styles.twoCol}>
            <VoteTally
              field="Sender"
              options={[
                { label: 'MAINSAIL', count: 18 },
                { label: 'OFFUTT', count: 4 },
                { label: 'ANDREWS', count: 1 },
              ]}
            />
            <VoteTally
              field="3rd codeword"
              options={[
                { label: '4F', count: 12 },
                { label: '4S', count: 3 },
                { label: '4X', count: 1 },
              ]}
            />
          </div>
        </Section>

        <Section
          id="modal"
          eyebrow="14 — Modal header"
          title="Dialog framing"
          lede="Accent top-rule + eyebrow + title. Pair with body + footer in real use."
        >
          <ModalHeader
            eyebrow="Confirm decommission"
            title="Delete recording cape-rx-01-20260524-031422.wav?"
            subtitle="Soft-deletes the row + delete-marker on S3. Restorable for 30 days."
            onClose={() => undefined}
          />
        </Section>

        <Section
          id="footer-section"
          eyebrow="15 — Footer"
          title="Page chrome"
          lede="Mock site footer that anchors the page. Operational pulse indicates last health check."
        >
          <div />
        </Section>
      </main>
      <Footer buildId="415-preview" />
    </div>
  );
}

function Header() {
  const [clock, setClock] = useState<string>('');
  useEffect(() => {
    const tick = () => setClock(new Date().toISOString().slice(0, 19).replace('T', ' '));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <header className={styles.header}>
      <div className={styles.brandRow}>
        <span className={styles.brandMark} aria-hidden>
          ▣
        </span>
        <span className={styles.brandText}>AUTONOMOUS&nbsp;SENTINEL</span>
        <span className={styles.brandSep} aria-hidden>
          ·
        </span>
        <span className={styles.brandTag}>SIGINT/HFGCS · STYLE-GUIDE</span>
      </div>
      <div className={styles.headerRight}>
        <span className={styles.clock} suppressHydrationWarning>
          {clock ? `${clock}Z` : ' '}
        </span>
        <ThemeToggle />
      </div>
    </header>
  );
}

interface SectionProps {
  id: string;
  eyebrow: string;
  title: string;
  lede?: string;
  children: React.ReactNode;
}

function Section({ id, eyebrow, title, lede, children }: SectionProps) {
  const ref = eyebrow.split('—')[0]?.trim() ?? '';
  return (
    <section id={id} className={styles.section}>
      <aside className={styles.gutter} aria-hidden>
        <span className={styles.refNum}>§{ref}</span>
        <span className={styles.gutterRule} />
      </aside>
      <div className={styles.sectionHead}>
        <div className={styles.eyebrow}>{eyebrow}</div>
        <h2 className={styles.sectionTitle}>{title}</h2>
        {lede && <p className={styles.lede}>{lede}</p>}
      </div>
      <div className={styles.sectionBody}>{children}</div>
    </section>
  );
}

function Swatch({ name }: { name: string }) {
  return (
    <div className={styles.swatch}>
      <div className={styles.swatchChip} style={{ background: `var(${name})` }} />
      <div className={styles.swatchMeta}>
        <code>{name}</code>
      </div>
    </div>
  );
}

interface StatProps {
  label: string;
  value: string;
  trend?: string;
  tone?: 'info' | 'success' | 'warn' | 'danger';
}

function Stat({ label, value, trend, tone }: StatProps) {
  const trendColor = tone
    ? `var(--color-${tone === 'warn' ? 'warn' : tone})`
    : 'var(--color-fg-muted)';
  return (
    <div className={styles.stat}>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue}>{value}</div>
      {trend && (
        <div className={styles.statTrend} style={{ color: trendColor }}>
          {trend}
        </div>
      )}
    </div>
  );
}

function IconUpload() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M8 12V3M8 3l-3 3M8 3l3 3" strokeLinecap="round" />
      <path d="M2 13h12" strokeLinecap="round" />
    </svg>
  );
}

function IconArrow() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 8h10M9 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
