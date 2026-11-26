/**
 * The search of the demo's phone bar, as Cloud's shell has it (`openPageSearch`): the demo is the host of its bar
 * (`data-k2-host-search`), so on the phone the search of the page's head leaves the head, and a tap here opens it over
 * the head with the keyboard. A page whose head has no search keeps the button without a deed, as the picture it is.
 */
export default function V2PhoneSearch() {
  const field = () =>
    document.querySelector<HTMLInputElement>('[data-k2-host-search] [data-slot="head"] [data-k2-part="Input"][data-search] > input');
  return (
    <button type="button" class="ui-v2-phonebar__button ui-v2-phonebar__search" aria-label="Suchen" onClick={() => field()?.focus()}>
      <i class="ti ti-search" aria-hidden="true" />
    </button>
  );
}
