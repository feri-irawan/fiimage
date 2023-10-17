# fiimage

Resize image and create a thumbnail of a video, made with ❤ by Feri Irawan at 28/12/2022

## Resize Image

The query strings are:

| Name           | Description                                        |
| -------------- | -------------------------------------------------- |
| `url`          | The Image URL                                      |
| `s` (optional) | The size will be generate. For example `s=100x100` |

### Auto Width

You can use the `?` mark, like this: `s=?xHEIGHT`. This means the width will be auto.

Example:

```
https://fiimage.vercel.app?s=?x200&url=https://images.unsplash.com/photo-1518791841217-8f162f1e1131
```

Output:

![Cat](https://fiimage.vercel.app/?s=?x200&url=https://images.unsplash.com/photo-1518791841217-8f162f1e1131)

### Auto Height

Similar to [auto width](#auto-width), you can also use the `?` mark, like this: `s=200x?`

Example:

```
https://fiimage.vercel.app?s=200x?&url=https://images.unsplash.com/photo-1518791841217-8f162f1e1131
```

Output:

![Cat](https://fiimage.vercel.app/?s=200x?&url=https://images.unsplash.com/photo-1518791841217-8f162f1e1131)

### Force width and height

You can use `s=300x200`, that means the width will be `300px` and height will be `200px`.

Example:

```
https://fiimage.vercel.app?s=300x200&url=https://images.unsplash.com/photo-1518791841217-8f162f1e1131
```

Output:

![Cat](https://fiimage.vercel.app/?s=300x300&url=https://images.unsplash.com/photo-1518791841217-8f162f1e1131)

## Generate Video Thumbanil

The query strings are:

| Name           | Description                                                                    |
| -------------- | ------------------------------------------------------------------------------ |
| `url`          | The Video URL                                                                  |
| `s` (optional) | The thumbnail size (similar to [image resize](#resize-image))                  |
| `t` (optional) | The time (in seconds) of the video that will be used to generate the thumbnail |

Example:

```
https://fiimage.vercel.app/?s=300x?&t=5&url=http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4
```

Output:

![Big Buck Bunny](https://fiimage.vercel.app/?s=300x?&t=5&url=http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4)
