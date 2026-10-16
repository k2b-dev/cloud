import { AppWorkspace } from "@k2b/ui";
import { render } from "solid-js/web";
import BookNavigator, { type BookNavigatorProps } from "./BookNavigator.island";

const props: BookNavigatorProps = JSON.parse(document.getElementById("book-props")!.textContent!);
render(
  () => (
    <div class="notebook-book-shell">
      <AppWorkspace mobileSurface="flush" class="notebook-book-workspace">
        <BookNavigator {...props} />
        <AppWorkspace.Content>
          <AppWorkspace.Main class="notebook-book-main">
            <article id="notebook-book-content" class="notebook-book-content">
              <h1>{props.selectedNoteId === "note01" ? "Guide" : "Glossary"}</h1>
              <p>{props.selectedNoteId === "note01" ? "Our handbook explains how the team works together." : "Terms used by our team."}</p>
            </article>
          </AppWorkspace.Main>
        </AppWorkspace.Content>
      </AppWorkspace>
    </div>
  ),
  document.getElementById("root")!,
);
