import {
  Avatar,
  announce,
  Button,
  ChoiceTiles,
  ColorChoices,
  dialogCore,
  FileDropzone,
  ImageCropper,
  type ImageCropState,
  PanelDialog,
  panelDialogWorkspaceOptions,
  panelDialogWorkspacePanelClass,
  prompts,
  Tabs,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createResource, createSignal, For, type JSX, Match, on, Show, Switch } from "solid-js";
import { chooseFiles } from "../browser/files";
import {
  AVATAR_BACKGROUNDS,
  type AvatarConfig,
  AvatarConfigSchema,
  type AvatarKind,
  PERSON_BEARDS,
  PERSON_BROWS,
  PERSON_EXTRAS,
  PERSON_EYES,
  PERSON_FACES,
  PERSON_GLASSES,
  PERSON_HAIR_COLORS,
  PERSON_HAIRSTYLES,
  PERSON_HEADWEAR,
  PERSON_MOUTHS,
  PERSON_SKIN_TONES,
  type PersonAvatar,
  ROBOT_ANTENNAS,
  ROBOT_BODIES,
  ROBOT_COLORS,
  ROBOT_EYES,
  ROBOT_HEADS,
  ROBOT_MOUTHS,
  type RobotAvatar,
  randomizePersonAvatar,
  randomRobotAvatar,
  startPersonAvatar,
} from "../contracts/avatar";
import { avatarSwatches, renderAvatarSvg } from "../shared/avatar-art";
import { AvatarUploadError, createAvatarDataUrlFromFile, validateAvatarSourceFile } from "./avatar-upload";
import { profilePictureMessages } from "./profile-picture-messages";

/** What the dialog reads and writes: the shape of `GET/PUT /api/me/avatar` and the service-account routes. */
export type ProfilePictureState = {
  kind: AvatarKind;
  built: AvatarConfig | null;
  hasPhoto: boolean;
  photo: string | null;
  avatarHash: string | null;
};

export type ProfilePictureChange = { dataUrl: string } | { built: AvatarConfig } | { use: AvatarKind };

export type ProfilePictureDialogOptions = {
  /** A person picks photo, avatar, or initials; an agent picks photo or robot. */
  subject: "person" | "agent";
  /** The account's name; initials come from it. */
  name: string;
  load: () => Promise<ProfilePictureState>;
  save: (change: ProfilePictureChange) => Promise<ProfilePictureState>;
  deletePhoto: () => Promise<ProfilePictureState>;
};

type Way = "photo" | "built" | "initials";
type Messages = ReturnType<typeof profilePictureMessages.resolve>["t"];
type Part = { key: string; label: string; options: readonly string[]; labels: string; color?: Record<string, string> };
type Category = { id: string; label: string; parts: Part[] };

const SIZES = [64, 40, 32, 24, 20] as const;

const partValue = (config: AvatarConfig, key: string): string => {
  const record: Record<string, unknown> = config;
  return String(record[key] ?? "");
};
/** A config with one part changed, validated against its shape set. */
const withPart = (config: AvatarConfig, key: string, value: string): AvatarConfig => AvatarConfigSchema.parse({ ...config, [key]: value });
const PHOTO_TYPES = "image/png,image/jpeg,image/webp";

/** A built avatar drawn inline from its config; the markup holds only shapes from fixed ids. */
function Drawing(props: { config: AvatarConfig; size: number | "fill"; crop?: "full" | "thumbnail"; label?: string }): JSX.Element {
  const sizeStyle = () =>
    props.size === "fill" ? { width: "100%", height: "100%" } : { width: `${props.size}px`, height: `${props.size}px` };
  const markup = () => renderAvatarSvg(props.config, props.crop ?? "full");
  const shape = () => (props.config.kind === "robot" ? "square" : "circle");
  return (
    <Show
      when={props.label}
      fallback={
        <span class="cloud-profile-picture__drawing" data-shape={shape()} style={sizeStyle()} aria-hidden="true" innerHTML={markup()} />
      }
    >
      {(label) => (
        <span
          class="cloud-profile-picture__drawing"
          data-shape={shape()}
          style={sizeStyle()}
          role="img"
          aria-label={label()}
          innerHTML={markup()}
        />
      )}
    </Show>
  );
}

function Initials(props: { name: string; size: number }): JSX.Element {
  return (
    <Avatar
      name={props.name}
      style={{ width: `${props.size}px`, height: `${props.size}px`, "font-size": `${Math.round(props.size * 0.36)}px` }}
    />
  );
}

function Photo(props: { src: string; size: number; square: boolean }): JSX.Element {
  return (
    <img
      class="cloud-profile-picture__photo"
      data-shape={props.square ? "square" : "circle"}
      src={props.src}
      alt=""
      style={{ width: `${props.size}px`, height: `${props.size}px` }}
    />
  );
}

const personCategories = (t: Messages): Category[] => {
  const part = (key: keyof PersonAvatar, label: string, options: readonly string[], color?: Record<string, string>): Part => ({
    key,
    label,
    options,
    labels: key,
    color,
  });
  const colorMap = (list: { id: string; color: string }[]) => Object.fromEntries(list.map((swatch) => [swatch.id, swatch.color]));
  return [
    {
      id: "face",
      label: t.face,
      parts: [part("face", t.faceShape, PERSON_FACES), part("skin", t.skin, PERSON_SKIN_TONES, colorMap(avatarSwatches.skin))],
    },
    {
      id: "hair",
      label: t.hair,
      parts: [
        part("hair", t.hairstyle, PERSON_HAIRSTYLES),
        part("hairColor", t.hairColor, PERSON_HAIR_COLORS, colorMap(avatarSwatches.hairColor)),
      ],
    },
    { id: "eyes", label: t.eyes, parts: [part("eyes", t.eyes, PERSON_EYES)] },
    { id: "brows", label: t.brows, parts: [part("brows", t.eyebrows, PERSON_BROWS)] },
    { id: "mouth", label: t.mouth, parts: [part("mouth", t.mouth, PERSON_MOUTHS)] },
    { id: "beard", label: t.beard, parts: [part("beard", t.beard, PERSON_BEARDS)] },
    { id: "glasses", label: t.glasses, parts: [part("glasses", t.glasses, PERSON_GLASSES)] },
    { id: "head", label: t.head, parts: [part("head", t.headwear, PERSON_HEADWEAR)] },
    { id: "extra", label: t.extra, parts: [part("extra", t.extra, PERSON_EXTRAS)] },
    { id: "bg", label: t.colour, parts: [part("bg", t.backgroundAndClothes, AVATAR_BACKGROUNDS, colorMap(avatarSwatches.bg))] },
  ];
};

const robotCategories = (t: Messages): Category[] => {
  const colorMap = (list: { id: string; color: string }[]) => Object.fromEntries(list.map((swatch) => [swatch.id, swatch.color]));
  const part = (
    key: keyof RobotAvatar,
    label: string,
    options: readonly string[],
    labels: string,
    color?: Record<string, string>,
  ): Part => ({
    key,
    label,
    options,
    labels,
    color,
  });
  return [
    { id: "head", label: t.head, parts: [part("head", t.head, ROBOT_HEADS, "robotHead")] },
    { id: "antenna", label: t.antenna, parts: [part("antenna", t.antenna, ROBOT_ANTENNAS, "antenna")] },
    { id: "eyes", label: t.eyes, parts: [part("eyes", t.eyes, ROBOT_EYES, "robotEyes")] },
    { id: "mouth", label: t.mouth, parts: [part("mouth", t.mouth, ROBOT_MOUTHS, "robotMouth")] },
    { id: "body", label: t.body, parts: [part("body", t.body, ROBOT_BODIES, "body")] },
    {
      id: "colors",
      label: t.colours,
      parts: [
        part("color", t.casing, ROBOT_COLORS, "color", colorMap(avatarSwatches.robotColor)),
        part("bg", t.background, AVATAR_BACKGROUNDS, "bg", colorMap(avatarSwatches.bg)),
      ],
    },
  ];
};

function Builder(props: {
  subject: "person" | "agent";
  draft: AvatarConfig;
  base: AvatarConfig;
  canUndo: boolean;
  category: string;
  onCategory: (id: string) => void;
  onChange: (key: string, value: string, label: string) => void;
  onRandom: () => void;
  onUndo: () => void;
  onReset: () => void;
  t: Messages;
}): JSX.Element {
  const categories = createMemo(() => (props.subject === "person" ? personCategories(props.t) : robotCategories(props.t)));
  const changed = () => JSON.stringify(props.draft) !== JSON.stringify(props.base);
  const hairHidden = () => props.draft.kind === "person" && (props.draft.head === "hijab" || props.draft.head === "turban");
  const value = (key: string) => partValue(props.draft, key);
  const label = (part: Part, id: string) => props.t.option({ part: part.labels, id });

  const partControl = (part: Part) =>
    part.color ? (
      <ColorChoices
        label={part.label}
        value={value(part.key)}
        options={part.options.map((id) => ({ value: id, label: label(part, id), color: part.color?.[id] ?? "transparent" }))}
        onValueChange={(next) => props.onChange(part.key, next, label(part, next))}
      />
    ) : (
      <ChoiceTiles
        label={part.label}
        description={
          part.key === "hair" && hairHidden()
            ? props.t.hairHidden({
                cover: props.draft.kind === "person" && props.draft.head === "hijab" ? props.t.hijabCover : props.t.turbanCover,
              })
            : part.key === "beard"
              ? props.t.beardColour
              : undefined
        }
        dimmed={part.key === "hair" && hairHidden()}
        value={value(part.key)}
        options={part.options.map((id) => ({
          value: id,
          label: label(part, id),
          visual: <Drawing config={withPart(props.draft, part.key, id)} size={60} crop="thumbnail" />,
        }))}
        onValueChange={(next) => props.onChange(part.key, next, label(part, next))}
      />
    );

  return (
    <div class="cloud-profile-picture__builder">
      <div class="cloud-profile-picture__preview">
        <span class="cloud-profile-picture__big">
          <Drawing config={props.draft} size="fill" label={props.t.preview} />
        </span>
        <div class="cloud-profile-picture__stack">
          <div class="cloud-profile-picture__sizes" role="group" aria-label={props.t.previewSizes}>
            <For each={SIZES}>
              {(size) => (
                <figure>
                  <Drawing config={props.draft} size={size} />
                  <figcaption>{size}</figcaption>
                </figure>
              )}
            </For>
          </div>
          <div
            class="k2b-ui cloud-profile-picture__sizes cloud-profile-picture__sizes--dark"
            data-theme="dark"
            role="group"
            aria-label={props.t.previewDark}
          >
            <For each={SIZES}>
              {(size) => (
                <figure>
                  <Drawing config={props.draft} size={size} />
                  <figcaption>{size}</figcaption>
                </figure>
              )}
            </For>
          </div>
          <div class="cloud-profile-picture__tools">
            <Button type="button" variant="ghost" size="sm" onClick={props.onRandom}>
              <i class="ti ti-dice-5" aria-hidden="true" />
              {props.t.random}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={props.onUndo}
              disabled={!props.canUndo}
              aria-label={props.t.undo}
              title={props.t.undo}
            >
              <i class="ti ti-arrow-back-up" aria-hidden="true" />
              <span class="cloud-profile-picture__tool-label">{props.t.undo}</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={props.onReset}
              disabled={!changed()}
              aria-label={props.t.reset}
              title={props.t.reset}
            >
              <i class="ti ti-restore" aria-hidden="true" />
              <span class="cloud-profile-picture__tool-label">{props.t.reset}</span>
            </Button>
          </div>
        </div>
      </div>
      <div class="cloud-profile-picture__parts">
        <Tabs
          ariaLabel={props.t.parts}
          variant="pill"
          value={props.category}
          onValueChange={props.onCategory}
          options={categories().map((category) => ({
            value: category.id,
            label: category.label,
            panel: <div class="cloud-profile-picture__panel">{category.parts.map(partControl)}</div>,
          }))}
        />
      </div>
    </div>
  );
}

function ProfilePictureDialog(
  props: ProfilePictureDialogOptions & {
    close: (state?: ProfilePictureState) => void;
    setDismissHandler: (handler: () => void | Promise<void>) => void;
  },
): JSX.Element {
  const locale = useLocale();
  const t = () => profilePictureMessages.resolve([locale()]).t;
  const [state, { refetch, mutate }] = createResource(() => props.load());
  // Reading a failed resource throws; every reader goes through this guard and the error branch shows the retry.
  const loaded = () => (state.state === "ready" || state.state === "refreshing" ? state() : undefined);
  const [way, setWay] = createSignal<Way | null>(null);
  const [openWay, setOpenWay] = createSignal<Way>("built");
  const [draft, setDraft] = createSignal<AvatarConfig | null>(null);
  const [base, setBase] = createSignal<AvatarConfig | null>(null);
  const [history, setHistory] = createSignal<AvatarConfig[]>([]);
  const [category, setCategory] = createSignal(props.subject === "person" ? "face" : "head");
  const [photoSource, setPhotoSource] = createSignal<File | null>(null);
  const [crop, setCrop] = createSignal<ImageCropState | null>(null);
  const [photoError, setPhotoError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const [saveError, setSaveError] = createSignal(false);
  // A deleted photo changed the server state even when the person then closes without saving.
  let changedOnServer: ProfilePictureState | undefined;
  const square = props.subject === "agent";

  // The first load decides where the dialog opens: a person without a built avatar starts on a random first draft.
  createEffect(
    on(loaded, (current) => {
      if (!current || draft()) return;
      const first = current.built ?? (props.subject === "person" ? startPersonAvatar() : randomRobotAvatar());
      setDraft(first);
      setBase(first);
      const opening: Way = current.kind === "initials" && !current.built ? "built" : current.kind;
      setOpenWay(opening);
      setWay(opening);
    }),
  );
  const ready = () => Boolean(loaded()) && draft() !== null;

  const current = () => way() ?? openWay();
  const photoReachable = () => current() !== "photo" || Boolean(loaded()?.hasPhoto) || photoSource() !== null;
  const same = (a: AvatarConfig | null | undefined, b: AvatarConfig | null | undefined) => JSON.stringify(a) === JSON.stringify(b);
  // Changed by the person in this dialog: closing asks first, and the footer says it is not saved yet.
  const touched = () => photoSource() !== null || (current() !== openWay() && photoReachable()) || !same(draft(), base());
  // Different from what is stored: only then does Save send anything. A first draft of a new avatar counts.
  const differsFromStored = () => {
    const stored = loaded();
    if (!stored) return false;
    if (photoSource()) return true;
    if (current() === "built") return stored.kind !== "built" || !same(draft(), stored.built);
    return current() !== stored.kind && photoReachable();
  };
  const busy = () => saving() || deleting();
  const canSave = () =>
    ready() &&
    !busy() &&
    // A new photo needs its crop; without a stored photo there is nothing else to show.
    (photoSource() ? crop() !== null : !(current() === "photo" && !loaded()?.hasPhoto));

  const requestClose = async () => {
    if (busy()) return;
    if (touched()) {
      const discard = await prompts.confirm(t().discardBody, {
        title: t().discardTitle,
        variant: "danger",
        confirmText: t().discardConfirm,
        cancelText: t().discardCancel,
      });
      if (!discard || busy()) return;
    }
    props.close(changedOnServer);
  };
  props.setDismissHandler(requestClose);

  const change = (key: string, value: string, label: string) => {
    const before = draft();
    if (!before || partValue(before, key) === value) return;
    setHistory((list) => [...list, before]);
    setDraft(withPart(before, key, value));
    setSaveError(false);
    announce(t().chosen({ name: label }));
  };
  const randomize = () => {
    const before = draft();
    if (!before) return;
    setHistory((list) => [...list, before]);
    setDraft(before.kind === "person" ? randomizePersonAvatar(before) : randomRobotAvatar());
    setSaveError(false);
    announce(t().randomized);
  };
  const undo = () => {
    const list = history();
    const previous = list.at(-1);
    if (!previous) return;
    setHistory(list.slice(0, -1));
    setDraft(previous);
    announce(t().undone);
  };
  const reset = () => {
    const before = draft();
    const original = base();
    if (!before || !original) return;
    setHistory((list) => [...list, before]);
    setDraft(original);
    announce(t().resetDone);
  };

  const choosePhoto = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setPhotoError(null);
    try {
      validateAvatarSourceFile(file);
      setPhotoSource(file);
      setCrop(null);
    } catch (error) {
      setPhotoError(uploadErrorMessage(error));
    }
  };

  const uploadErrorMessage = (error: unknown) => {
    if (!(error instanceof AvatarUploadError)) return t().photoProcessFailed;
    if (error.code === "type_invalid") return t().photoTypeInvalid;
    if (error.code === "too_large") return t().photoTooLarge;
    if (error.code === "empty") return t().photoEmpty;
    if (error.code === "unsupported") return t().photoUnsupported;
    return t().photoProcessFailed;
  };

  const save = async () => {
    if (!loaded() || !canSave()) return;
    if (!differsFromStored()) {
      props.close(changedOnServer);
      return;
    }
    setSaving(true);
    setSaveError(false);
    try {
      const target = current();
      const file = photoSource();
      const area = crop();
      const built = draft();
      // A new photo is saved only with its crop; it never falls back to showing the stored one.
      if (target === "photo" && file && !area) return;
      const next =
        target === "photo" && file && area
          ? await props.save({ dataUrl: await createAvatarDataUrlFromFile(file, area) })
          : target === "built" && built
            ? await props.save({ built })
            : await props.save({ use: target });
      props.close(next);
    } catch (error) {
      if (error instanceof AvatarUploadError) setPhotoError(uploadErrorMessage(error));
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };

  const deletePhoto = async () => {
    if (busy()) return;
    setDeleting(true);
    setPhotoError(null);
    try {
      const next = await props.deletePhoto();
      changedOnServer = next;
      mutate(next);
      setPhotoSource(null);
      if (openWay() === "photo") setOpenWay(next.kind);
      announce(t().photoDeleted);
    } catch {
      setPhotoError(t().photoDeleteFailed);
    } finally {
      setDeleting(false);
    }
  };

  const wayOptions = () => {
    const current = loaded();
    const visual = (kind: Way) => {
      if (kind === "photo") {
        return current?.photo ? (
          <Photo src={current.photo} size={36} square={square} />
        ) : (
          <span class="cloud-profile-picture__empty" data-shape={square ? "square" : "circle"}>
            <i class="ti ti-photo" />
          </span>
        );
      }
      if (kind === "built") return <Show when={draft()}>{(config) => <Drawing config={config()} size={36} />}</Show>;
      return <Initials name={props.name} size={36} />;
    };
    const ways: Way[] = props.subject === "person" ? ["photo", "built", "initials"] : ["photo", "built"];
    return ways.map((kind) => ({
      value: kind,
      label: kind === "photo" ? t().photo : kind === "built" ? (props.subject === "person" ? t().avatar : t().robot) : t().initials,
      status: current?.kind === kind ? t().active : "",
      visual: visual(kind),
    }));
  };

  const photoPane = () => {
    const current = loaded();
    const file = photoSource();
    return (
      <div class="cloud-profile-picture__pane">
        <Show
          when={file || current?.photo}
          fallback={
            <FileDropzone
              accept={PHOTO_TYPES}
              multiple={false}
              choose={() => chooseFiles({ accept: PHOTO_TYPES })}
              error={photoError}
              icon="ti ti-photo-up"
              title={t().photoDrop}
              subtitle={t().photoFormats}
              hint={t().photoChoose}
              onDrop={choosePhoto}
            />
          }
        >
          <Show when={file} fallback={<Photo src={current?.photo ?? ""} size={160} square={square} />}>
            <div class="cloud-profile-picture__cropper">
              <ImageCropper
                source={file as File}
                aspect={{ width: 1, height: 1 }}
                previewShape={square ? "rect" : "circle"}
                onValueChange={setCrop}
              />
            </div>
          </Show>
          <Show when={photoError()}>
            <p role="alert">{photoError()}</p>
          </Show>
          <p>{file ? t().photoNew : current?.kind === "photo" ? t().photoActive : t().photoHidden}</p>
          <div class="cloud-profile-picture__row">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void chooseFiles({ accept: PHOTO_TYPES }).then(choosePhoto)}
              disabled={deleting()}
            >
              <i class="ti ti-replace" aria-hidden="true" />
              {t().photoOther}
            </Button>
            <Show when={current?.hasPhoto}>
              <Button type="button" variant="danger" size="sm" onClick={deletePhoto} disabled={deleting()}>
                <i class="ti ti-trash" aria-hidden="true" />
                {t().photoDelete}
              </Button>
            </Show>
          </div>
        </Show>
      </div>
    );
  };

  return (
    <PanelDialog>
      <PanelDialog.Header title={t().title} close={requestClose} />
      <PanelDialog.Body>
        {/* While a save or a deletion runs, the choices hold still, so the saved picture is the one on screen. */}
        <div class="cloud-profile-picture" inert={busy() ? true : undefined} aria-busy={busy() ? "true" : undefined}>
          <Switch>
            <Match when={state.error}>
              <div class="cloud-profile-picture__pane" role="alert">
                <p>{t().loadFailed}</p>
                <Button type="button" variant="secondary" size="sm" onClick={() => void refetch()}>
                  {t().retry}
                </Button>
              </div>
            </Match>
            <Match when={!ready()}>
              <div class="cloud-profile-picture__pane" role="status" aria-label={t().loading}>
                <span class="cloud-profile-picture__placeholder" />
              </div>
            </Match>
            <Match when={ready()}>
              <ChoiceTiles
                aria-label={t().ways}
                layout="row"
                value={current()}
                options={wayOptions()}
                onValueChange={(next) => {
                  setWay(next);
                  setSaveError(false);
                }}
              />
              {/* Every kind stays mounted, so a crop or a draft survives a look at another kind. */}
              <div class="cloud-profile-picture__body">
                <div hidden={current() !== "photo"}>{photoPane()}</div>
                <div hidden={current() !== "built"}>
                  <Show when={draft()}>
                    {(config) => (
                      <Builder
                        subject={props.subject}
                        draft={config()}
                        base={base() ?? config()}
                        canUndo={history().length > 0}
                        category={category()}
                        onCategory={setCategory}
                        onChange={change}
                        onRandom={randomize}
                        onUndo={undo}
                        onReset={reset}
                        t={t()}
                      />
                    )}
                  </Show>
                </div>
                <div hidden={current() !== "initials"}>
                  <div class="cloud-profile-picture__pane">
                    <Initials name={props.name} size={160} />
                    <p>{t().initialsInfo}</p>
                  </div>
                </div>
              </div>
            </Match>
          </Switch>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <div class="cloud-profile-picture__status" role={saveError() ? "alert" : "status"} data-error={saveError() ? "true" : undefined}>
          <Show when={saveError()} fallback={touched() ? t().unsaved : props.subject === "person" ? t().visiblePerson : t().visibleAgent}>
            <i class="ti ti-alert-circle" aria-hidden="true" />
            <span>{t().saveFailed}</span>
            <button type="button" class="cloud-profile-picture__retry" onClick={() => void save()}>
              {t().retry}
            </button>
          </Show>
        </div>
        <div class="cloud-profile-picture__actions">
          <Button type="button" variant="secondary" size="sm" onClick={requestClose} disabled={busy()}>
            {t().cancel}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            class="cloud-profile-picture__save"
            onClick={() => void save()}
            disabled={!canSave()}
          >
            <Show when={saving()} fallback={t().save}>
              <i class="ti ti-loader-2" aria-hidden="true" />
              {t().saving}
            </Show>
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

/**
 * Opens "Change profile picture": a person picks a photo, a built avatar, or initials; an agent picks a photo or its
 * robot. Resolves with the new state when something changed on the server, or `undefined` when nothing did.
 */
export const openProfilePictureDialog = (options: ProfilePictureDialogOptions): Promise<ProfilePictureState | undefined> =>
  dialogCore.open<ProfilePictureState | undefined>(
    (close, context) => <ProfilePictureDialog {...options} close={close} setDismissHandler={context.setDismissHandler} />,
    { ...panelDialogWorkspaceOptions, panelClassName: `${panelDialogWorkspacePanelClass} cloud-profile-picture-dialog`, history: true },
  );
