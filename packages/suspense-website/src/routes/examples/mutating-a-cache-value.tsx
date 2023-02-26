import { Link } from "react-router-dom";
import Block from "../../components/Block";
import Code from "../../components/Code";
import Container from "../../components/Container";
import { ExternalLink } from "../../components/ExternalLink";
import Header from "../../components/Header";
import Note from "../../components/Note";
import { createCache, createStreamingCache, demos } from "../../examples";
import Demo from "../../examples/demos/mutating-a-cache-value";

export default function Route() {
  return (
    <Container>
      <Block>
        <Header title="mutating a cache value" />
      </Block>
      <Block>
        <p>Coming soon.</p>
      </Block>
      <Block type="demo">
        <Demo />
      </Block>
    </Container>
  );
}