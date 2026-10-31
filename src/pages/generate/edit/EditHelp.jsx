import { t } from "../../../i18n/index.js";

// Mouse and key reference for the open tab, opened from the ? in the stage head
// so the screen itself stays free of instructions.
export default function EditHelp({ tab }) {
  const Kbd = ({ children }) => <kbd className="edit-kbd">{children}</kbd>;
  return (
    <div className="edit-menu edit-help">
      <div className="insp-eyebrow">{t("MOUSE")}</div>
      {tab === "regen" ? (
        <dl className="insp-keys">
          <dt>{t("Click a section or bar")}</dt><dd>{t("Pick it, or unpick it")}</dd>
          <dt>{t("Click or drag the timeline")}</dt><dd>{t("Move the playhead")}</dd>
          <dt>{t("[ ] on the timeline")}</dt><dd>{t("What the roll shows")}</dd>
          <dt><Kbd>Alt</Kbd> + {t("drag the timeline")}</dt><dd>{t("Don't snap to sections")}</dd>
          <dt>{t("Drag across the roll")}</dt><dd>{t("Pick bars")}</dd>
          <dt>{t("Drag over picked bars")}</dt><dd>{t("Unpick them")}</dd>
          <dt>{t("Right-drag")}</dt><dd>{t("Unpick bars")}</dd>
          <dt>{t("Drag a bar-row block")}</dt><dd>{t("Move that area")}</dd>
          <dt>{t("Drag its grips")}</dt><dd>{t("Stretch it")}</dd>
          <dt>{t("Click its arrow")}</dt><dd>{t("Stretch it to the end")}</dd>
          <dt>{t("Wheel")}</dt><dd>{t("Scroll the roll")}</dd>
          <dt><Kbd>Ctrl</Kbd> + {t("wheel")}</dt><dd>{t("Zoom")}</dd>
        </dl>
      ) : (
        <dl className="insp-keys">
          <dt>{t("Click a section")}</dt><dd>{t("Jump to it")}</dd>
          <dt>{t("Click or drag the timeline")}</dt><dd>{t("Move the playhead")}</dd>
          <dt>{t("[ ] on the timeline")}</dt><dd>{t("What the roll shows")}</dd>
          <dt><Kbd>Alt</Kbd> + {t("drag the timeline")}</dt><dd>{t("Don't snap to sections")}</dd>
          <dt>{t("Click empty space")}</dt><dd>{t("Add a note")}</dd>
          <dt>{t("Drag")}</dt><dd>{t("Select notes")}</dd>
          <dt><Kbd>Shift</Kbd> + {t("click")}</dt><dd>{t("Add to the selection")}</dd>
          <dt>{t("Drag a note")}</dt><dd>{t("Move it")}</dd>
          <dt>{t("Drag a note's end")}</dt><dd>{t("Sustain")}</dd>
          <dt>{t("Right-click")}</dt><dd>{t("Delete")}</dd>
          <dt>{t("Wheel")}</dt><dd>{t("Scroll the roll")}</dd>
          <dt><Kbd>Ctrl</Kbd> + {t("wheel")}</dt><dd>{t("Zoom")}</dd>
        </dl>
      )}
      <div className="insp-eyebrow">{t("KEYS")}</div>
      <dl className="insp-keys">
        <dt><Kbd>Tab</Kbd></dt><dd>{t("Inpaint / Edit")}</dd>
        <dt><Kbd>{t("Space")}</Kbd></dt><dd>{t("Play / pause")}</dd>
        <dt><Kbd>[</Kbd> <Kbd>]</Kbd></dt><dd>{t("Previous / next section")}</dd>
        <dt><Kbd>L</Kbd></dt><dd>{t("Loop")}</dd>
        {tab === "regen" ? (
          <><dt><Kbd>R</Kbd></dt><dd>{t("Inpaint the selection")}</dd></>
        ) : (
          <>
            <dt><Kbd>T</Kbd> <Kbd>H</Kbd> <Kbd>S</Kbd> <Kbd>Q</Kbd></dt><dd>{t("Tap, HOPO, star power, snap")}</dd>
            <dt><Kbd>{t("Del")}</Kbd></dt><dd>{t("Delete notes")}</dd>
          </>
        )}
        <dt><Kbd>Ctrl</Kbd> <Kbd>Z</Kbd></dt><dd>{t("Undo")}</dd>
        <dt><Kbd>Esc</Kbd></dt><dd>{t("Clear the selection")}</dd>
      </dl>
    </div>
  );
}
