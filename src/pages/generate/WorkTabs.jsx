import { I } from "../../icons.jsx";

const TABS = [
  { id: "generate", label: "Generate", icon: I.boltFill, title: "Make new takes" },
  { id: "regen", label: "Inpaint", icon: I.spark, title: "Redo bars of the selected take" },
  { id: "edit", label: "Edit", icon: I.pencil, title: "Edit the selected take's notes" },
];

// The three jobs, at the top of the right rail. Inpaint and Edit open the
// selected take; the stage keeps playing through a switch. The bar stays
// pinned while the rail scrolls under it.
export default function WorkTabs({ project }) {
  const { workTab, openWorkTab, editBlockedReason } = project;
  return (
    <div className="work-tabs-bar">
      <div className="work-tabs" role="tablist" aria-label="Mode">
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
              title={blocked ? editBlockedReason : id === "generate" ? title : `${title} (Tab switches)`}
            >
              <Icon /> {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
