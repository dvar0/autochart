using System.Text.Json;
using YARG.Core;
using YARG.Core.Chart;
using YARG.Core.Song;
using YARG.Core.Song.Cache;
using YARG.Core.Venue;

static void Check(bool condition, string message)
{
    if (!condition) throw new Exception(message);
}

var root = args[0];
using var expected = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "expected.json")));
var cache = CacheHandler.RunScan(false, Path.Combine(root, "cache.bin"),
    Path.Combine(root, "badsongs.txt"), false, new() { Path.Combine(root, "Songs") });
var entries = cache.Entries.Values.SelectMany(list => list).ToList();
Check(entries.Count == expected.RootElement.GetArrayLength(),
    $"YARG scanned {entries.Count} songs, expected {expected.RootElement.GetArrayLength()}. " +
    (File.Exists(Path.Combine(root, "badsongs.txt")) ? File.ReadAllText(Path.Combine(root, "badsongs.txt")) : ""));
Check(CacheHandler.Progress.BadSongCount == 0, "YARG reported bad songs");

foreach (var item in expected.RootElement.EnumerateArray())
{
    var id = item.GetProperty("id").GetString()!;
    var entry = entries.Single(song => Path.GetFileName(song.ActualLocation) == id);
    Check(entry.Name.ToString() == item.GetProperty("title").GetString(), $"{id}: title");
    Check(entry.Charter.ToString() == "Autochart", $"{id}: fixed charter credit");
    Check(entry.Genre.ToString() == "Progressive Rock", $"{id}: musical genre");
    Check(entry.SongLengthMilliseconds == item.GetProperty("durationMs").GetInt64(), $"{id}: duration units");
    Check(entry.VideoStartTimeMilliseconds == item.GetProperty("videoStartMs").GetInt64(), $"{id}: video offset");
    Check(entry.SongOffsetMilliseconds == item.GetProperty("offsetMs").GetInt64(), $"{id}: chart offset");
    var chart = entry.LoadChart() ?? throw new Exception($"{id}: chart failed to load");
    foreach (var diff in item.GetProperty("difficulties").EnumerateArray())
    {
        var difficulty = Enum.Parse<Difficulty>(diff.GetString()!, true);
        Check(chart.FiveFretGuitar.TryGetDifficulty(difficulty, out var track), $"{id}: missing {difficulty}");
        var notes = track!.Notes;
        Check(notes.Count == 5, $"{id}/{difficulty}: note count {notes.Count}");
        Check(notes[0].IsChord && notes[0].NoteMask == 5, $"{id}/{difficulty}: green/yellow chord");
        Check(notes[0].TickLength == item.GetProperty("resolution").GetUInt32() / 2, $"{id}: sustain");
        Check(notes[1].IsHopo, $"{id}: forced HOPO");
        Check(notes[2].IsTap, $"{id}: tap");
        Check(notes[3].Fret == (int) FiveFretGuitarFret.Open, $"{id}: open note");
        var expectedTimes = new[] { 0.5, 1, 1.5, 2, 2.4 };
        for (var i = 0; i < notes.Count; i++)
            Check(Math.Abs(notes[i].Time - expectedTimes[i]) < 0.000001, $"{id}: tempo-map time at note {i}: {notes[i].Time}");
    }
    // Video selection is in Core; decoding/playback requires Unity.
    using var background = entry.LoadBackground();
    Check(background?.Type == BackgroundType.Video, $"{id}: video selection");
    Console.WriteLine($"YARG scanned and loaded {id}: metadata, difficulty tracks, note semantics, tempo map and video selection passed.");
}
