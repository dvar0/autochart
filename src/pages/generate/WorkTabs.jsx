import { I } from "../../icons.jsx";
import { msg, t } from "../../i18n/index.js";

const TABS = [
  { id: "generate", label: msg("Generate"), icon: I.boltFill, title: msg("Make new takes") },
  { id: "regen", label: msg("Inpaint"), icon: I.spark, title: msg("Redo bars of the selected take") },
  { id: "edit", label: msg("Edit"), icon: I.pencil, title: msg("Edit the selected take's notes") },
];

// The three jobs, at the top of the right rail. Inpaint and Edit open the
// selected take; the stage keeps playing through a switch. The bar stays
// pinned while the rail scrolls under it.
export default function WorkTabs({ project }) {
  const { workTab, openWorkTab, editBlockedReason } = project;
  return (
    <div className="work-tabs-bar">
      <div className="work-tabs" role="tablist" aria-label={t("Mode")}>
        {TABS.map(({ id, label, icon: Icon, title }) => {
          const blocked = id !== "generate" && workTab === "generate" && Boolean(editBlockedReason);
          return (
            <button
              key={id}
              role="tab"
              aria-selected={workTab === id}
              className={workTab === id ? "active" : ""}
              data-tab={id}
              onClick={() => void openWorkTab(id)}
              disabled={blocked}
              title={blocked ? editBlockedReason : id === "generate" ? t(title) : t("{action} (Tab switches)", { action: t(title) })}
            >
              <Icon /> {t(label)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
