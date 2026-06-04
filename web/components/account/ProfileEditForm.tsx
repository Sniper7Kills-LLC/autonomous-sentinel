'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { Alert } from '@/components/ui/Alert';
import { getProfile, updateMyProfile, resolveAvatarUrl } from '@/lib/users/profile';
import styles from './ProfileEditForm.module.css';

/** Max characters for the free-form bio / description field. */
const BIO_MAX = 500;

/**
 * Subset of the profile read we consume on the edit page. The data-layer
 * read (`getProfile`, #85/#736) carries these editable fields; we type
 * only what this form binds rather than re-deriving the full read shape.
 */
interface EditableProfile {
  displayName: string | null;
  preferredUsername: string | null;
  bio: string | null;
  avatarKey: string | null;
}

/**
 * `<ProfileEditForm>` — self-service edit surface for the signed-in
 * user's public profile (#736).
 *
 * Pre-fills from `getProfile(sub)` on mount, then writes the four
 * editable fields through `updateMyProfile`. Avatar uploads go straight
 * to S3 via Amplify Storage under `profile-photos/{identityId}/avatar`;
 * the resulting storage path is what we persist as `avatarKey` (the
 * image bytes never round-trip through the GraphQL mutation).
 */
export function ProfileEditForm({ sub }: { sub: string }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState('');
  const [preferredUsername, setPreferredUsername] = useState('');
  const [bio, setBio] = useState('');
  const [avatarKey, setAvatarKey] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Pre-fill from the live profile on mount.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const profile = (await getProfile(sub)) as EditableProfile | null;
        if (cancelled) return;
        if (profile) {
          setDisplayName(profile.displayName ?? '');
          setPreferredUsername(profile.preferredUsername ?? '');
          setBio(profile.bio ?? '');
          setAvatarKey(profile.avatarKey ?? null);
          if (profile.avatarKey) {
            const url = await resolveAvatarUrl(profile.avatarKey);
            if (!cancelled) setAvatarUrl(url);
          }
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sub]);

  const onPickAvatar = useCallback(async (file: File) => {
    setUploading(true);
    setSaveError(null);
    setSaved(false);
    // Show a local preview immediately while the upload runs.
    const localPreview = URL.createObjectURL(file);
    setAvatarUrl(localPreview);
    try {
      const { fetchAuthSession } = await import('aws-amplify/auth');
      const { identityId } = await fetchAuthSession();
      const path = `profile-photos/${identityId}/avatar`;
      const { uploadData } = await import('aws-amplify/storage');
      const result = await uploadData({
        path,
        data: file,
        options: { contentType: file.type },
      }).result;
      setAvatarKey(result.path);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }, []);

  const onSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      await updateMyProfile({
        displayName,
        preferredUsername,
        bio,
        ...(avatarKey ? { avatarKey } : {}),
      });
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [displayName, preferredUsername, bio, avatarKey]);

  if (loading) {
    return (
      <p style={{ fontFamily: 'var(--font-jb-mono)', color: 'var(--text-2)' }}>
        Loading your profile…
      </p>
    );
  }

  if (loadError) {
    return (
      <Alert tone="danger" title="Could not load your profile">
        {loadError}
      </Alert>
    );
  }

  const bioOver = bio.length > BIO_MAX;

  return (
    <form
      noValidate
      className={styles.shell}
      aria-label="Edit profile"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave();
      }}
    >
      <div className={styles.avatarRow}>
        <div className={styles.avatarPreview}>
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} alt="Avatar preview" className={styles.avatarImg} />
          ) : (
            <span className={styles.avatarFallback} aria-hidden>
              ◎
            </span>
          )}
        </div>
        <Field label="Avatar" htmlFor="avatar-file" hint="PNG / JPG. Square images look best.">
          <input
            id="avatar-file"
            type="file"
            accept="image/*"
            disabled={uploading || saving}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onPickAvatar(file);
            }}
          />
          {uploading && <span className={styles.uploadHint}>Uploading…</span>}
        </Field>
      </div>

      <Field label="Display name" htmlFor="display-name">
        <Input
          id="display-name"
          type="text"
          value={displayName}
          maxLength={120}
          onChange={(e) => {
            setDisplayName(e.target.value);
            setSaved(false);
          }}
        />
      </Field>

      <Field label="Username" htmlFor="preferred-username" hint="Your public handle.">
        <Input
          id="preferred-username"
          type="text"
          value={preferredUsername}
          maxLength={60}
          onChange={(e) => {
            setPreferredUsername(e.target.value);
            setSaved(false);
          }}
        />
      </Field>

      <Field
        label="Description"
        htmlFor="bio"
        hint={
          <span className={bioOver ? styles.counterOver : undefined}>
            {bio.length}/{BIO_MAX}
          </span>
        }
        error={bioOver ? `Keep your description under ${BIO_MAX} characters.` : undefined}
      >
        <Textarea
          id="bio"
          rows={5}
          value={bio}
          invalid={bioOver}
          onChange={(e) => {
            setBio(e.target.value);
            setSaved(false);
          }}
        />
      </Field>

      {saveError && (
        <Alert tone="danger" title="Could not save your profile">
          {saveError}
        </Alert>
      )}
      {saved && <Alert tone="success">Profile saved.</Alert>}

      <div className={styles.actions}>
        <Button type="submit" loading={saving} disabled={saving || uploading || bioOver}>
          Save profile
        </Button>
      </div>
    </form>
  );
}
