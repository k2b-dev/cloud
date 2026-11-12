// The Lightbox's heavy renderers in one module of their own, loaded when a file needs one. It is not part of the
// package index, so an app that only offers the Lightbox never carries the document, PDF and video code up front.
export { default as FileView } from "./FileView";
export { default as PdfViewer } from "./PdfViewer";
export { default as VideoPlayer } from "./VideoPlayer";
