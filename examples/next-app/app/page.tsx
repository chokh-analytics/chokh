import Link from 'next/link';

import { SignUp } from './sign-up';

export default function Home() {
  return (
    <main>
      <h1>Home</h1>
      <Link href="/about">About</Link>
      <SignUp />
    </main>
  );
}
