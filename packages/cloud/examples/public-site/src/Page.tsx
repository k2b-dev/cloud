import { ADDRESS, type PageContent } from "./content";
import ShareButton from "./ShareButton.island";

export const Page = (props: { content: PageContent; canonical: string; alternate: string; logo: string }) => (
  <>
    <header>
      <img src={props.logo} alt="" width="48" height="48" />
      <a href={props.alternate}>{props.content.switchLabel}</a>
    </header>
    <main>
      <h1>{props.content.heading}</h1>
      <p>{props.content.intro}</p>
      <section>
        <h2>{props.content.hoursTitle}</h2>
        <dl>
          {props.content.hours.map(([day, time]) => (
            <>
              <dt>{day}</dt>
              <dd>{time}</dd>
            </>
          ))}
        </dl>
      </section>
      <section>
        <h2>{props.content.addressTitle}</h2>
        <address>
          {ADDRESS.street}
          <br />
          {ADDRESS.postalCode} {ADDRESS.city}
        </address>
      </section>
      <ShareButton url={props.canonical} label={props.content.share} copied={props.content.copied} />
    </main>
  </>
);
