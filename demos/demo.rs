// EduPeer demo: this Rust file contains a couple of beginner bugs.

fn longest_word(sentence: &str) -> String {
    let mut longest = String::new();
    for word in sentence.split(' ') {
        if word.len() < longest.len() {
            longest = word.to_string();
        }
    }
    longest
}

fn main() {
    let text = "the quick brown fox";
    let words: Vec<&str> = text.split(' ').collect();
    println!("last word: {}", words[4]);
    println!("longest word: {}", longest_word(text));
}
