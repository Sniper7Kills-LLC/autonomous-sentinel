'use client';

import { Badge, MessageTypeBadge } from '@/components/ui/Badge';
import { Alert } from '@/components/ui/Alert';
import { MessageDetail, type ParsedMessage } from '@/components/messages/MessageDetail';
import styles from './page.module.css';

/**
 * Sample messages embedded in the editorial. Each one is calibrated to a
 * specific point we're making about its format. Synthesized — not lifted
 * verbatim from any single intercept — to avoid republishing operational
 * authenticators.
 */
const SAMPLE_EAM: ParsedMessage = {
  id: 'about-eam',
  type: 'ALLSTATIONS',
  broadcastTs: '2026-05-24 03:14:22Z',
  sender: 'MAINSAIL',
  receiver: 'ALL STATIONS',
  frequency: '11.175 USB',
  repetitions: 2,
  confidence: 0.93,
  body: {
    kind: 'ALLSTATIONS',
    preamble: '7FTBE4',
    characters: '7FTBE47KQ2BHC9LMP3JXR6VWATBDUN5',
    auth: 'XW',
  },
};

const SAMPLE_SKYKING: ParsedMessage = {
  id: 'about-skyking',
  type: 'SKYKING',
  broadcastTs: '2026-05-24 01:22:03Z',
  sender: 'MAINSAIL',
  receiver: 'ANY AIRBORNE COMMAND',
  frequency: '11.175 USB',
  repetitions: 2,
  confidence: 0.95,
  body: {
    kind: 'SKYKING',
    time: '14',
    codeword: 'BEARS',
    auth: '9D',
  },
};

const SAMPLE_RADIOCHECK: ParsedMessage = {
  id: 'about-radiocheck',
  type: 'RADIOCHECK',
  broadcastTs: '2026-05-23 22:10:19Z',
  sender: 'OFFUTT',
  receiver: 'MAINSAIL',
  frequency: '8.992 USB',
  confidence: 0.99,
  body: {
    kind: 'RADIOCHECK',
    result: 'LOUD AND CLEAR',
  },
};

export default function AboutPage() {
  return (
    <>
      <Hero />

      <Section num="01" title="What this site catalogues" eyebrow="Mission">
        <p>
          Autonomous Sentinel is an open-source archive of Emergency Action Messages and related
          shortwave radio traffic intercepted on the{' '}
          <abbr title="High Frequency Global Communications System">HFGCS</abbr>. Volunteers run
          software-defined radios that auto-capture broadcasts and upload them to the pipeline. The
          pipeline transcribes the audio, parses each transmission into a structured record, and
          publishes the result for community validation.
        </p>
        <p>
          The catalogue is read-only and freely browsable. Recordings older than 90 days, bulk
          downloads, and advanced filters sit behind a paid supporter tier; the underlying
          transcripts and parsed metadata stay free forever. The project is sponsored, maintained,
          and operated by Sniper7Kills LLC.
        </p>

        <Alert tone="info" title="What we are not">
          We are not affiliated with the U.S. Department of Defense, the U.S. Air Force, USSTRATCOM,
          or any other government agency. EAM broadcasts are
          unencrypted-yet-cryptographically-authenticated transmissions in the open radio spectrum.
          Cataloguing them is entirely lawful in the United States, where the project and its
          volunteers operate.
        </Alert>
      </Section>

      <Section num="02" title="HFGCS, in one paragraph" eyebrow="Context">
        <p>
          The High Frequency Global Communications System is the U.S. Air Force shortwave network
          used to pass orders to nuclear-capable forces and to coordinate the strategic command and
          control network. It is operated from <strong>Mainsail</strong> &mdash; a rotating
          net-control station &mdash; and uses a small set of public frequencies in the HF band,
          most notably <code>11.175 USB</code>, <code>8.992 USB</code>, <code>15.016 USB</code>, and{' '}
          <code>4.724 USB</code>. Anyone with a receiver tuned to those frequencies can hear the
          broadcasts; what&rsquo;s broadcast is encrypted in cipher form, not in transmission form.
        </p>
      </Section>

      <Section num="03" title="Message types" eyebrow="Taxonomy">
        <p>
          HFGCS traffic divides cleanly into a small number of recognisable categories. Every
          published Message in this archive carries one of the following type tags:
        </p>

        <ul className={styles.typeList}>
          <li>
            <MessageTypeBadge type="ALLSTATIONS" /> <strong>Emergency Action Message.</strong>{' '}
            Addressed to <em>all stations</em>, the workhorse format. Detailed below.
          </li>
          <li>
            <MessageTypeBadge type="SKYKING" /> <strong>Skyking / Foxtrot broadcast.</strong>{' '}
            Higher-priority order addressed to airborne nuclear command. Will interrupt an EAM in
            progress.
          </li>
          <li>
            <MessageTypeBadge type="SKYBIRD" /> <strong>Skybird traffic.</strong> Two-way
            operational exchange between net control and a specific airborne unit.
          </li>
          <li>
            <MessageTypeBadge type="SKYMASTER" /> <strong>Skymaster traffic.</strong> Coordination
            with ground-control or relay nodes.
          </li>
          <li>
            <MessageTypeBadge type="RADIOCHECK" /> <strong>Radio check / test count.</strong>{' '}
            Network-verification broadcast; no operational significance.
          </li>
          <li>
            <MessageTypeBadge type="BACKEND" /> <strong>Site announcement.</strong> Not radio
            traffic &mdash; a message from this site&rsquo;s administrators to operators and viewers
            (maintenance windows, policy updates, etc.).
          </li>
          <li>
            <MessageTypeBadge type="DISREGARDED" /> <strong>Disregarded.</strong> Net control
            retracts a prior transmission.
          </li>
          <li>
            <MessageTypeBadge type="OTHER" /> <strong>Other.</strong> Anything that didn&rsquo;t fit
            a template above.
          </li>
        </ul>
      </Section>

      <Section num="04" title="EAM format" eyebrow="ALL STATIONS">
        <p>
          A standard EAM follows a fixed script. The transmitter opens with{' '}
          <q>All stations, all stations, this is Mainsail, Mainsail</q>, then reads a{' '}
          <strong>six-character alphanumeric preamble</strong> three times in NATO phonetic, each
          repetition followed by <q>Stand by</q>. The full message then follows. The first six
          characters of the body are the same preamble &mdash; that&rsquo;s what ties a given
          transmission to the auth key window currently in effect. The body is read out at roughly
          one character per second, then the entire message is read again after <q>I say again</q>.
        </p>

        <h3 className={styles.h3}>Length</h3>
        <p>
          <strong>30 characters total is the most common length</strong>, but it is not a hard rule.
          28 and 22 are also routine; longer messages do happen and run into the hundreds. Whenever
          the broadcast is <em>not</em> the default 30, the transmitter explicitly announces the
          count: <q>Message of forty-two characters follows</q>. Our UI tags each message with its
          actual character count so the difference is visible at a glance.
        </p>

        <h3 className={styles.h3}>Character set</h3>
        <p>
          EAM bodies are alphanumeric but practice excludes the digits <code>0</code>,{' '}
          <code>1</code>, <code>8</code>, and <code>9</code> &mdash; these are ambiguous when spoken
          under HF conditions. Any transcribed body containing those digits is flagged as suspect
          for community review.
        </p>

        <h3 className={styles.h3}>Auth window</h3>
        <p>
          The first two characters of the preamble are{' '}
          <strong>stable for a period of roughly 8&ndash;26 days</strong>, indicating which page of
          the on-board authentication codebook to consult. Those two characters are surfaced as the{' '}
          <em>auth window</em> on every published Message.
        </p>

        <h3 className={styles.h3}>Closure</h3>
        <p>
          Most EAMs close with <q>This is Mainsail, out</q>. When net control has more queued, it
          instead says <q>more to follow, stand by</q>, and the next transmission begins shortly
          after. The pipeline splits chained broadcasts into separate Messages.
        </p>

        <h3 className={styles.h3}>Worked example</h3>
        <MessageDetail message={SAMPLE_EAM} />
      </Section>

      <Section num="05" title="Skyking format" eyebrow="FOXTROT BROADCAST">
        <p>
          A Skyking message is the highest-priority broadcast on the network. It is addressed to any
          airborne nuclear command element and is preceded by the unmistakable preamble{' '}
          <q>Skyking, Skyking. Do not answer.</q> The receiver does <em>not</em> acknowledge.
        </p>

        <p>
          The body is short. A single codeword &mdash; either a three-letter phonetic group or,
          since around 2015, a codename like <code>BEARS</code> or <code>BILBO</code> &mdash; is
          read twice. The transmitter then announces <q>Time</q> followed by the minutes past the
          UTC hour and <q>Authentication</q> followed by a two-character time-dependent
          authenticator. The entire body is then repeated after <q>I say again</q>, and the
          transmission closes with <q>This is Mainsail, out</q>.
        </p>

        <p>
          Because the Time field changes minute-to-minute and the authenticator changes on a
          published schedule, a Skyking is useless without access to the corresponding codebook
          &mdash; even though anyone with a shortwave radio can hear it.
        </p>

        <h3 className={styles.h3}>Worked example</h3>
        <MessageDetail message={SAMPLE_SKYKING} />
      </Section>

      <Section num="06" title="Radio checks" eyebrow="TEST COUNT">
        <p>
          Net-control stations periodically transmit test counts to verify their signal reaches
          every receiver in the network. The canonical form is{' '}
          <q>
            This is Mainsail with a test count; testing, one two three four five, five four three
            two one; this is Mainsail, out
          </q>
          . Two-way exchanges (<q>radio check, over</q> &rarr; signal-quality response) are
          similarly tagged.
        </p>

        <p>
          Test counts carry no operational weight; the archive records them for completeness and
          because they help calibrate transcription quality against the rest of the catalogue.
        </p>

        <h3 className={styles.h3}>Worked example</h3>
        <MessageDetail message={SAMPLE_RADIOCHECK} />
      </Section>

      <Section num="07" title="Skybird, Skymaster, and Mainsail traffic" eyebrow="OPERATIONAL">
        <p>
          Not every broadcast on HFGCS is a structured EAM. Net control and aircraft routinely
          exchange short operational voice traffic &mdash; entering and leaving the network,
          requesting relays, passing shorthand authentication. These exchanges use <em>Skybird</em>,{' '}
          <em>Skymaster</em>, and direct callsign addressing and follow no fixed body template. The
          archive captures them as free-form text under their respective type tag.
        </p>
      </Section>

      <Section num="08" title="Glossary" eyebrow="Terminology">
        <dl className={styles.glossary}>
          <dt>HFGCS</dt>
          <dd>
            High Frequency Global Communications System. The U.S. Air Force shortwave network this
            archive monitors.
          </dd>

          <dt>Mainsail</dt>
          <dd>
            The rotating net-control callsign on HFGCS. Whoever is acting as net control at any
            given moment uses this callsign on the air.
          </dd>

          <dt>Skyking</dt>
          <dd>
            A short, high-priority broadcast addressed to airborne nuclear command. Synonym:{' '}
            <em>Foxtrot broadcast</em>.
          </dd>

          <dt>Skybird</dt>
          <dd>A generic addressing tag for an airborne unit operating on HFGCS.</dd>

          <dt>EAM</dt>
          <dd>
            Emergency Action Message. The fixed-format 30-ish-character broadcast described under
            &sect;04.
          </dd>

          <dt>Preamble</dt>
          <dd>
            The first six characters of an EAM body, read three times at the start of the
            transmission, each repetition followed by <q>Stand by</q>. The first two preamble
            characters identify the current auth window.
          </dd>

          <dt>Auth window</dt>
          <dd>
            The two-character key indicator embedded in the EAM preamble. Stable for roughly
            8&ndash;26 days at a time. Surfaced on every published Message as a deniability /
            attribution-resistance metric.
          </dd>

          <dt>I say again</dt>
          <dd>
            Standard military repetition marker. Most EAM and Skyking broadcasts repeat the body
            verbatim once after this phrase.
          </dd>

          <dt>More to follow</dt>
          <dd>
            Net-control signal that another EAM is queued and will be transmitted immediately after
            the current one closes. The pipeline splits chained broadcasts into individual Message
            records.
          </dd>
        </dl>
      </Section>

      <Section num="09" title="Sources" eyebrow="References">
        <p>
          This page synthesizes publicly-documented HFGCS protocol from the following sources. All
          operational specifics in the body of the site are recovered from broadcasted audio &mdash;
          no classified material is reproduced.
        </p>
        <ul className={styles.sources}>
          <li>
            <a
              href="https://priyom.org/military-stations/united-states/hfgcs"
              rel="noopener noreferrer"
              target="_blank"
            >
              priyom.org &mdash; HFGCS station profile
            </a>
          </li>
          <li>
            <a
              href="http://mt-milcom.blogspot.com/p/what-is-emergency-action-message-or-eam.html"
              rel="noopener noreferrer"
              target="_blank"
            >
              Milcom Monitoring Post &mdash; What are Emergency Action Messages?
            </a>
          </li>
          <li>
            <a
              href="https://lswilson.dewlineadventures.com/skyking/"
              rel="noopener noreferrer"
              target="_blank"
            >
              The DEWLine &mdash; Skyking Emergency Action Message
            </a>
          </li>
          <li>
            <a
              href="https://www.sigidwiki.com/wiki/HFGCS_(High_Frequency_Global_Communications_System)"
              rel="noopener noreferrer"
              target="_blank"
            >
              Signal Identification Wiki &mdash; HFGCS
            </a>
          </li>
          <li>
            <a
              href="https://en.wikipedia.org/wiki/Emergency_Action_Message"
              rel="noopener noreferrer"
              target="_blank"
            >
              Wikipedia &mdash; Emergency Action Message
            </a>
          </li>
          <li>
            <a
              href="https://www.ab9il.net/aviation/naoc-tacamo.html"
              rel="noopener noreferrer"
              target="_blank"
            >
              AB9IL &mdash; Nuclear Warriors on HF Radio
            </a>
          </li>
        </ul>
      </Section>

      <Section num="10" title="Corrections welcome" eyebrow="Errata">
        <p>
          The format notes here are based on open-source research and community-reported intercepts.
          Anyone with first-hand HFGCS operating experience who spots an inaccuracy is invited to
          file an issue or open a pull request on{' '}
          <a
            href="https://github.com/Sniper7Kills-LLC/autonomous-sentinel"
            rel="noopener noreferrer"
            target="_blank"
          >
            GitHub
          </a>
          . This page is a living document and will be amended as the archive matures.
        </p>
      </Section>
    </>
  );
}

function Hero() {
  return (
    <section className={styles.hero}>
      <div className={styles.heroInner}>
        <div className={styles.heroEyebrow}>
          <Badge tone="accent">DOSSIER</Badge>
          <span className={styles.heroRef}>REF-04221 · v4.0</span>
        </div>
        <h1 className={styles.heroTitle}>Reading the shortwave that orders the bombers.</h1>
        <p className={styles.heroLede}>
          A field guide to Emergency Action Messages, Skyking broadcasts, and the public shortwave
          protocol that carries them. Written for operators, researchers, and anyone curious about
          what they just heard on 11.175 USB.
        </p>
      </div>
    </section>
  );
}

interface SectionProps {
  num: string;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}

function Section({ num, eyebrow, title, children }: SectionProps) {
  return (
    <section className={styles.section}>
      <aside className={styles.gutter} aria-hidden>
        <span className={styles.refNum}>&sect;{num}</span>
        <span className={styles.gutterRule} />
      </aside>
      <div className={styles.sectionHead}>
        <div className={styles.eyebrow}>{eyebrow}</div>
        <h2 className={styles.sectionTitle}>{title}</h2>
      </div>
      <div className={styles.sectionBody}>{children}</div>
    </section>
  );
}
