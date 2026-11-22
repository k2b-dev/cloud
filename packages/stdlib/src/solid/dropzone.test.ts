import { describe, it, expect, mock } from "bun:test";
import { testRoot } from "../_test-helpers";
import { dropzone } from "./dropzone";

/** Helper to create a minimal DragEvent-like object */
const fakeDragEvent = (overrides: Record<string, any> = {}) =>
  ({
    preventDefault: mock(() => {}),
    stopPropagation: mock(() => {}),
    dataTransfer: null,
    ...overrides,
  }) as unknown as DragEvent;

describe("dropzone.create", () => {
  it("returns isDragging, invalidDrag signals and handlers", () => {
    const { result, dispose } = testRoot(() => dropzone.create({}));
    expect(result.isDragging()).toBe(false);
    expect(result.invalidDrag()).toBe(false);
    expect(typeof result.handlers.onDragEnter).toBe("function");
    expect(typeof result.handlers.onDragLeave).toBe("function");
    expect(typeof result.handlers.onDragOver).toBe("function");
    expect(typeof result.handlers.onDrop).toBe("function");
    dispose();
  });

  it("onDragEnter increments drag counter, making isDragging true", () => {
    const { result, dispose } = testRoot(() => dropzone.create({}));

    const event = fakeDragEvent({
      dataTransfer: { types: ["Files"], items: [] },
    });
    (result.handlers.onDragEnter as any)(event);
    expect(result.isDragging()).toBe(true);
    dispose();
  });

  it("onDragLeave decrements drag counter back to not dragging", () => {
    const { result, dispose } = testRoot(() => dropzone.create({}));

    // Enter once
    const enterEvent = fakeDragEvent({
      dataTransfer: { types: ["Files"], items: [] },
    });
    (result.handlers.onDragEnter as any)(enterEvent);
    expect(result.isDragging()).toBe(true);

    // Leave once
    const leaveEvent = fakeDragEvent();
    (result.handlers.onDragLeave as any)(leaveEvent);
    expect(result.isDragging()).toBe(false);
    dispose();
  });

  it("handles nested drag enter/leave correctly (drag counter pattern)", () => {
    const { result, dispose } = testRoot(() => dropzone.create({}));

    const enterEvent = () =>
      fakeDragEvent({ dataTransfer: { types: ["Files"], items: [] } });
    const leaveEvent = () => fakeDragEvent();

    // Enter parent element
    (result.handlers.onDragEnter as any)(enterEvent());
    expect(result.isDragging()).toBe(true);

    // Enter child element (counter goes to 2)
    (result.handlers.onDragEnter as any)(enterEvent());
    expect(result.isDragging()).toBe(true);

    // Leave parent element (counter goes to 1) -- still dragging
    (result.handlers.onDragLeave as any)(leaveEvent());
    expect(result.isDragging()).toBe(true);

    // Leave child element (counter goes to 0) -- no longer dragging
    (result.handlers.onDragLeave as any)(leaveEvent());
    expect(result.isDragging()).toBe(false);
    dispose();
  });

  it("onDragLeave does not go below zero", () => {
    const { result, dispose } = testRoot(() => dropzone.create({}));

    const leaveEvent = fakeDragEvent();
    (result.handlers.onDragLeave as any)(leaveEvent);
    (result.handlers.onDragLeave as any)(leaveEvent);

    expect(result.isDragging()).toBe(false);
    dispose();
  });

  it("onDrop calls callback with files", () => {
    const onDrop = mock(() => {});
    const { result, dispose } = testRoot(() => dropzone.create({ onDrop }));

    const file = new File(["content"], "test.txt", { type: "text/plain" });
    const event = fakeDragEvent({
      dataTransfer: { files: [file] },
    });

    (result.handlers.onDrop as any)(event);
    expect(onDrop).toHaveBeenCalledTimes(1);
    const dropArgs = onDrop.mock.calls[0] as unknown as [File[]];
    expect(dropArgs[0]).toHaveLength(1);
    expect(dropArgs[0][0]!.name).toBe("test.txt");
    dispose();
  });

  it("onDrop resets isDragging and invalidDrag", () => {
    const { result, dispose } = testRoot(() => dropzone.create({}));

    // First set isDragging to true
    const enterEvent = fakeDragEvent({
      dataTransfer: { types: ["Files"], items: [] },
    });
    (result.handlers.onDragEnter as any)(enterEvent);
    expect(result.isDragging()).toBe(true);

    // Now drop (even with no files)
    const dropEvent = fakeDragEvent({
      dataTransfer: { files: [] },
    });
    (result.handlers.onDrop as any)(dropEvent);

    expect(result.isDragging()).toBe(false);
    expect(result.invalidDrag()).toBe(false);
    dispose();
  });

  it("onDrop does not call callback when no files are dropped", () => {
    const onDrop = mock(() => {});
    const { result, dispose } = testRoot(() => dropzone.create({ onDrop }));

    const event = fakeDragEvent({
      dataTransfer: { files: [] },
    });

    (result.handlers.onDrop as any)(event);
    expect(onDrop).not.toHaveBeenCalled();
    dispose();
  });

  it("filters files by accept option", () => {
    const onDrop = mock(() => {});
    const { result, dispose } = testRoot(() =>
      dropzone.create({ accept: "image/*", onDrop }),
    );

    const imgFile = new File([""], "photo.png", { type: "image/png" });
    const txtFile = new File([""], "doc.txt", { type: "text/plain" });
    const event = fakeDragEvent({
      dataTransfer: { files: [imgFile, txtFile] },
    });

    (result.handlers.onDrop as any)(event);
    expect(onDrop).toHaveBeenCalledTimes(1);
    const passedFiles = (onDrop.mock.calls[0] as unknown as [File[]])[0];
    expect(passedFiles).toHaveLength(1);
    expect(passedFiles[0]!.name).toBe("photo.png");
    expect(passedFiles.every((f) => f.type.startsWith("image/"))).toBe(true);
    dispose();
  });

  it("does not call onDrop when all files are filtered out by accept", () => {
    const onDrop = mock(() => {});
    const { result, dispose } = testRoot(() =>
      dropzone.create({ accept: "image/*", onDrop }),
    );

    const txtFile = new File([""], "doc.txt", { type: "text/plain" });
    const event = fakeDragEvent({
      dataTransfer: { files: [txtFile] },
    });

    (result.handlers.onDrop as any)(event);
    expect(onDrop).not.toHaveBeenCalled();
    dispose();
  });

  it("onDragOver sets dropEffect based on invalidDrag", () => {
    const { result, dispose } = testRoot(() =>
      dropzone.create({ accept: "image/*" }),
    );

    // When no invalid drag, dropEffect should be "copy"
    const dataTransfer1 = { dropEffect: "" };
    const overEvent1 = fakeDragEvent({ dataTransfer: dataTransfer1 });
    (result.handlers.onDragOver as any)(overEvent1);
    expect(dataTransfer1.dropEffect).toBe("copy");

    dispose();
  });

  it("onDragEnter detects invalid file types and sets invalidDrag", () => {
    const { result, dispose } = testRoot(() =>
      dropzone.create({ accept: "image/*" }),
    );

    // Simulate drag with an invalid file type
    const event = fakeDragEvent({
      dataTransfer: {
        types: ["Files"],
        items: [{ kind: "file", type: "text/plain" }],
      },
    });
    (result.handlers.onDragEnter as any)(event);

    expect(result.isDragging()).toBe(true);
    expect(result.invalidDrag()).toBe(true);
    dispose();
  });

  it("onDragEnter ignores events without files", () => {
    const { result, dispose } = testRoot(() => dropzone.create({}));

    // No "Files" in types and no items
    const event = fakeDragEvent({
      dataTransfer: { types: ["text/plain"], items: null },
    });
    (result.handlers.onDragEnter as any)(event);

    // Should not increment drag counter
    expect(result.isDragging()).toBe(false);
    dispose();
  });
});
