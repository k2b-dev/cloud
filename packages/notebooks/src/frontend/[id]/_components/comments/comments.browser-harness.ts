import { mount } from "../../../../../../ssr/src/mount";
import NoteEditor from "../editor/NoteEditor.client";

mount(NoteEditor, 'solid-client[data-id="note-editor"]');
