# drone_flute_synth

### ▶ [**Play it**](https://kleer001.github.io/drone_flute_synth/)

A flute that never stops playing. One voice holds a drone underneath, another
wanders around on top, and it won't play you the same phrase twice in a row.

It runs in your browser. Nothing to install, and the whole thing is 3.3 MB.

Start it somewhere:
[A phrygian](https://kleer001.github.io/drone_flute_synth/?key=A&mode=phrygian) ·
[F# blues, restless](https://kleer001.github.io/drone_flute_synth/?key=F%23&mode=blues&mood=restless) ·
[C whole tone, half asleep](https://kleer001.github.io/drone_flute_synth/?key=C&mode=whole%20tone&mood=sleep)

## What it sounds like

It breathes. The melody runs until a player would need air, then everything
goes quiet for a moment and comes back in on the beat. The drone breathes with
it, because on a real drone flute both pipes share one lungful.

Pick a key and a scale, slide some drones in underneath, and leave it going.
It's meant to be left on.

Every performance has a seed. Same seed, same piece.

## Controls

| | |
|---|---|
| **key** | any of the twelve |
| **scale** | major, minor, the modes, harmonic minor, both pentatonics, blues, whole tone |
| **octave** | where the tune sits. Two octaves down still sounds like a flute. One up gets shrill, which is sometimes what you want |
| **drone 1–3** | three of them. Each on or off, at whatever interval you want under the tune |
| **mood** | contemplative, mourning, pastoral, ceremonial, restless, sleep |
| **the sliders** | how busy it is, how far it leaps, how much it decorates, how fast it moves, how long a breath lasts |
| **room** | reverb, tone, level |

Changes land on the next breath, so you never hear a phrase change its mind
halfway through. The room controls move while it plays.

The URL sets where it starts: `?key=A&mode=phrygian&mood=sleep&seed=42`.

<details>
<summary><b>How it comes up with the tune</b></summary>

<br>

It isn't shuffling notes. It writes a little phrase, three to five notes long,
then spends the next few breaths arguing with it: the same phrase backwards,
upside down, stretched long, cut off halfway.

Breaths come in pairs. The first one asks something and leaves it hanging,
lower and plainer. The second answers, and the answer is always the question
reworked rather than a new idea, which is why the two sound related. After
three or so goes it drops the phrase and writes another.

Inside a breath there's one high point, about two thirds through, and the line
climbs to it and comes back down. It lands on notes that sit still against the
drone, and it leans on the beat, so what you hear could be written on paper.

Turn **call / answer** up to hear the two halves pull apart. Turn **ornament**
and **trill** up and it starts showing off.

</details>

## Run it yourself

```bash
./run.sh
```

Serves the same files the public page does.

## Made of

Thirteen recordings of a baroque soprano recorder from
[VCSL](https://github.com/sgossner/VCSL), which is public domain. A recorder
isn't a drone flute. It's what a free licence gets you, and it sounds like a
recorder rather than the thing it's standing in for.

The code is [MIT](LICENSE). If you want to know how it works inside, that's
[CLAUDE.md](CLAUDE.md).
